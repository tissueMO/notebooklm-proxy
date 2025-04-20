import axios from 'axios';
import { promises as fs } from 'fs';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { chromium } from 'playwright';
import { Consumer } from 'sqs-consumer';
import { SQSClient } from '@aws-sdk/client-sqs';
import { CronJob } from 'cron';
import path from 'path';

const THREAD_TIMEOUT = 12 * 60 * 60 * 1000;
const s3Client = new S3Client();

// ブラウザー初期化
console.log('Chromium: ブラウザーを初期化します...');
const context = await chromium.launch().then(browser => initialize(browser));
const pageSessionMap = {};

// ページセッションのクリーンアップを定期的に実行
console.log('Cron: ページセッションクリーンアップのスケジュールを設定します...');
CronJob.from({
  cronTime: '0 */5 * * *',
  timeZone: 'Asia/Tokyo',
  onTick: () => cleanupOldSessions(),
})
  .start();

// SQSコンシューマー開始
console.log('SQSConsumer: SQSキューのポーリングを開始します...');
Consumer.create({
  sqs: new SQSClient(),
  queueUrl: process.env.SQS_QUEUE_URL,
  suppressFifoWarning: true,
  batchSize: 1,
  handleMessage: async (message) => {
    console.log('SQSConsumer: メッセージを受信しました:', message.MessageId, message.Body);
    try {
      await handler(message.Body);
      console.log('SQSConsumer: メッセージ処理完了:', message.MessageId);
    } catch (error) {
      console.error('SQSConsumer: メッセージ処理中にエラーが発生しました:', message.MessageId, error);
    }
  },
})
  .on('error', (err) => {
    console.error('SQSConsumer: エラーが発生しました:', err.message);
  })
  .on('processing_error', (err) => {
    console.error('SQSConsumer: メッセージ処理中にハンドルされないエラーが発生しました:', err.message);
  })
  .start();

/**
 * ブラウザーコンテキストを初期化します。
 * @param {import('playwright-core').Browser} browser
 * @returns {Promise<import('playwright-core').BrowserContext>}
 */
async function initialize(browser) {
  console.log('Chromium: ブラウザー上で新しいコンテキストを作成します...');

  // 前回の認証状態を復元
  let hasPreviousContext = false;
  try {
    const { Body: previousContextData } = await s3Client.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: 'chromium-contexts.json',
      }),
    );

    await fs.writeFile('/tmp/chromium-contexts.json', previousContextData);
    hasPreviousContext = true;
    console.log('Chromium: 前回のセッションを復元しました');
  } catch (e) {}

  // コンテキスト作成
  const context = await browser.newContext({
    locale: 'ja',
    viewport: { width: 1920, height: 1080 },
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(hasPreviousContext ? { storageState: '/tmp/chromium-contexts.json' } : {}),
  });

  // ログインフロー
  const page = await context.newPage();
  try {
    await page.goto(process.env.NOTEBOOK_URL);
    await page.waitForLoadState('domcontentloaded');

    const needsLogin = await page.$('input[type="email"]').then((element) => !!element);

    if (needsLogin) {
      // メールアドレス入力
      await page.$('input[type="email"]').then((element) => element.fill(process.env.GOOGLE_USER_NAME));
      await page.$$('button').then(async (elements) => {
        for (const element of elements) {
          const text = await element.textContent();
          if (text.trim() === '次へ') {
            await element.click();
            break;
          }
        }
      });
      await page.waitForLoadState('domcontentloaded');

      // パスワード入力
      await page.waitForSelector('input[type="password"]');
      await page.$('input[type="password"]').then((element) => element.fill(process.env.GOOGLE_USER_PASSWORD));
      await page.$$('button').then(async (elements) => {
        for (const element of elements) {
          const text = await element.textContent();
          if (text.trim() === '次へ') {
            await element.click();
            break;
          }
        }
      });

      // ※手動で多要素認証を通す
      console.log('Chromium: 本人確認を実施します...');
      const authS3Uri = await screenshot(page, 'screenshot/auth');
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        text: `本人確認が発生しました。60秒以内に対応してください。\n${authS3Uri}`,
      });

      // TODO: 本人確認の成否を確認する
      await page.waitForTimeout(60 * 1000);
      console.log('Chromium: 本人確認タイムアウト');

      // 認証後の状態を保存
      await page.context().storageState({ path: '/tmp/chromium-contexts.json' });
      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.S3_BUCKET,
          Key: 'chromium-contexts.json',
          Body: await fs.readFile('/tmp/chromium-contexts.json'),
        }),
      );
    }

  } finally {
    await screenshot(page, 'screenshot/initialized')
    await page.close();
  }

  return context;
}

/**
 * Notebookを開きます。
 * ※前回開いたページがある場合はスレッドの続きから再開します。
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} ts スレッド識別子
 * @returns {Promiose<import('playwright-core').Page>}
 */
async function openNotebook(context, ts) {
  // ※前回のページが残っていれば再利用する
  if (pageSessionMap[ts]) {
    console.log('Notebook: 以前のタブを再利用します:', ts);
    return pageSessionMap[ts];
  }

  // 新規ページ作成
  const page = await context.newPage();
  pageSessionMap[ts] = page;
  await page.goto(process.env.NOTEBOOK_URL);
  await page.waitForLoadState('domcontentloaded');
  return pageSessionMap[ts];
}

/**
 * NotebookLMで問合せを行い、その結果を返します。
 * @param {import('playwright-core').Page} page
 * @param {string} message 問合せ内容
 * @returns {Promise<string>}
 */
async function queryNotebook(page, message) {
  // メッセージ送信
  await page.$('textarea[aria-label="クエリボックス"]').then((element) => element.fill(message));
  await page.click('button[aria-label="送信"]');

  // レスポンス取得 ※非同期処理が終わるのを待つ
  for (let i = 0; i < 15 * 2; i++) {
    await page.waitForTimeout(500);

    const responseMessage = await page.$('.chat-message-pair:nth-last-child(1) chat-message:last-of-type').then((element) => element?.innerText());
    if (!responseMessage?.length) {
      continue;
    }

    // コピーボタンで整形済みMarkdownを取得
    await page.click('.chat-message-pair:nth-last-child(1) chat-message:last-of-type button[aria-label$="コピー"]');
    return await page.evaluate(() => navigator.clipboard.readText());
  }

  return '(Timeout)';
}

/**
 * NotebookLMで問い合わせを実行します。
 * @param {Object} payload
 * @param {string} payload.message
 * @param {Object} payload.slack
 */
async function handler(payload) {
  const data = JSON.parse(payload);
  const threadTimestamp = data.slack.thread_ts ?? data.slack.ts;

  // NotebookLM 問合せ実行
  const page = await openNotebook(context, threadTimestamp);
  await screenshot(page, `screenshot/finally-${threadTimestamp}`);
  const response = await queryNotebook(page, data.message);
  await screenshot(page, `screenshot/finally-${threadTimestamp}`);

  // メンション元スレッドに返信
  await axios.post(process.env.SLACK_WEBHOOK_URL, {
    thread_ts: threadTimestamp,
    text: `<@${data.slack.user}>`,
    attachments: [
      {
        title: 'NotebookLMからの回答',
        text: response,
        mrkdwn_in: ['text'],
      },
    ],
  });

  console.log('Slack: メンション元スレッドに回答を送信しました');
}

/**
 * 古いページセッションをクリーンアップします。
 */
async function cleanupOldSessions() {
  const now = Date.now();

  // 古くなったページセッションを抽出
  const oldSessionKeys = Object.keys(pageSessionMap)
    .filter(ts => now - Number.parseFloat(ts) * 1000 > THREAD_TIMEOUT);

  if (!oldSessionKeys.length) {
    return;
  }

  // 古いセッションをクリーンアップ
  console.log(`Cleanup: ${oldSessionKeys.length} 件の古いセッションをクリーンアップします...`);

  await Promise.all(oldSessionKeys.map(async (ts) => {
    try {
      await pageSessionMap[ts].close();
    } catch (err) {
      console.error(`Cron: セッションのクローズ中にエラーが発生しました:`, ts, err);
    } finally {
      delete pageSessionMap[ts];
    }
  }));

  console.log('Cleanup: ページセッションのクリーンアップ完了');
}

/**
 * [DEBUG] ページのスクリーンショットをS3にアップロードします。
 * @param {Page} page
 * @param {string} key ※拡張子不要、プレフィックス可
 * @returns {Promise<string>} S3URI
 */
async function screenshot(page, key) {
  const localPath = `/tmp/${path.basename(key)}.png`;

  await page.screenshot({ path: localPath });
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: `${key}.png`,
    Body: await fs.readFile(localPath),
    ContentType: 'image/png',
  }));

  return `s3://${process.env.S3_BUCKET}/${key}.png`;
}

/**
 * [DEBUG] ページのHTMLをS3にアップロードします。
 * @param {Page} page
 * @param {string} key ※拡張子不要、プレフィックス可
 * @returns {Promise<string>} S3URI
 */
async function dump(page, key) {
  await s3Client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: `${key}.html`,
    Body: await page.innerHTML('body'),
    ContentType: 'text/html',
  }));

  return `s3://${process.env.S3_BUCKET}/${key}.html`;
}

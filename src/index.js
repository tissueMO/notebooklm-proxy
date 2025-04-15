const fs = require('fs').promises;
const axios = require('axios');
const playwrightLambda = require('playwright-aws-lambda');
const { Page } = require('playwright-core');
const aws = require('aws-sdk');
const s3 = new aws.S3();
const lambda = new aws.Lambda();

/**
 * NotebookLMで問い合わせを実行します。
 * @param {Object} event
 * @param {string?} event.body
 * @returns {Promise<*>}
 */
exports.execute = async (event, context) => {
  // リクエスト検証
  if (!auth(event)) {
    return { statusCode: 400 };
  }

  // リクエスト前処理
  const preprocessReponse = await preprocess(event, context);
  if (preprocessReponse) {
    return preprocessReponse;
  }

  // リクエストボディ解析
  const data = JSON.parse(event?.body ?? '{}');
  const queryMessage = data.message;
  if (!queryMessage) {
    return { statusCode: 400 };
  }

  // (Slack向け) メンション元スレッドに受理応答
  if (data.slack) {
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      thread_ts: data.slack.ts,
      text: '(NotebookLMに問い合わせ中...)',
    });
    console.log('Slack: メンション元スレッドに受理応答を送信しました');
  }

  // NotebookLM 問合せ実行
  const { result } = await executeOnNotebookLM(process.env.NOTEBOOK_URL, async ({ page }) => {
    // メッセージ送信
    await page.$('textarea[aria-label="クエリボックス"]').then((element) => element.fill(queryMessage));
    await page.click('button[aria-label="送信"]');

    // レスポンス取得 ※非同期処理が終わるのを待つ
    try {
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(1000);

        const responseMessage = await page.$('chat-message:nth-child(2)').then(element => element?.innerText());
        if (!responseMessage?.length) {
          continue;
        }

        // コピーボタンで整形済みMarkdownを取得
        await page.click('chat-message:nth-child(2) button[aria-label$="コピー"]');
        return await page.evaluate(() => navigator.clipboard.readText());
      }

      return '(Timeout)';

    } finally {
      await screenshot(page, 'finally');
    }
  });

  // (Slack向け) メンション元スレッドに回答
  if (data.slack) {
    await axios.post(process.env.SLACK_WEBHOOK_URL, {
      thread_ts: data.slack.ts,
      text: `<@${data.slack.user}>`,
      attachments: [
        {
          title: 'NotebookLMからの回答',
          text: result,
          mrkdwn_in: ['text'],
        },
      ],
    });
    console.log('Slack: メンション元スレッドに回答を送信しました');
  }

  return {
    statusCode: 200,
    body: JSON.stringify(result),
  };
};

/**
 * NotebookLM上で任意の処理を行います。
 * @param {Function} callback
 * @param {Object} options
 * @returns {Promise<*>}
 */
const executeOnNotebookLM = async (notebookUrl, callback) => {
  console.log('Chromium: ヘッドレスブラウザーを初期化します...');

  const browser = await playwrightLambda.launchChromium();

  // 前回の認証状態を復元
  let hasPreviousContext = false;
  try {
    const { Body: previousContextData } = await s3
      .getObject({
        Bucket: process.env.SCREENSHOT_BUCKET,
        Key: 'chromium-contexts.json',
      })
      .promise();

    await fs.writeFile('/tmp/chromium-contexts.json', previousContextData);
    hasPreviousContext = true;
    console.log('Chromium: 前回のセッションを復元しました');

  } catch (e) {}

  const context = await browser.newContext({
    locale: 'ja',
    viewport: { width: 1920, height: 1080 },
    permissions: ['clipboard-read', 'clipboard-write'],
    ...(hasPreviousContext ? { storageState: '/tmp/chromium-contexts.json' } : {}),
  });

  // 最初のページに移動
  const page = await context.newPage();
  await page.goto(notebookUrl);
  await page.waitForLoadState('domcontentloaded');

  // ログインフロー
  const needsLogin = await page.$('input[type="email"]').then(element => !!element);
  if (needsLogin) {
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
    // TODO: 管理者宛にSlack通知でスクショを飛ばすようにする
    await screenshot(page, 'auth');
    await page.waitForTimeout(15000);

    // 認証後の状態を保存
    await page.context().storageState({ path: '/tmp/chromium-contexts.json' });
    await s3
      .putObject({
        Bucket: process.env.SCREENSHOT_BUCKET,
        Key: 'chromium-contexts.json',
        Body: await fs.readFile('/tmp/chromium-contexts.json'),
      })
      .promise();
  }

  // 任意の処理を実行
  console.log('Chromium: 任意の処理を実行します...');
  const result = callback ? await callback({ page }) : {};

  return {
    exitCode: 0,
    message: '成功',
    result,
  };
};

/**
 * SlackBotからのリクエストかどうかを判別します。
 * @param {Object} event
 * @returns {boolean}
 */
const isSlackBot = event => {
  return event.requestContext?.http?.userAgent?.startsWith('Slackbot') ?? false;
};

/**
 * リクエストを検証します。
 * @param {Object} event
 * @returns {boolean}
 */
const auth = event => {
  return isSlackBot(event) ? true : (event.headers?.['x-api-key'] === process.env.API_KEY);
};

/**
 * リクエストの前処理を行います。
 * @param {Object} event
 * @param {Object} context
 * @returns {Object?}
 */
const preprocess = async (event, context) => {
  const data = JSON.parse(event?.body ?? '{}');

  // Slack 初回チャレンジリクエストへの応答
  if (isSlackBot(event) && data.type === 'url_verification') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: data.challenge,
    };
  }

  // SlackBotのイベント通知は別Lambdaに非同期で流して即応答する
  if (isSlackBot(event) && data.type === 'event_callback') {
    console.log('Slack: イベント通知内容', data);

    event.headers['x-api-key'] = process.env.API_KEY;
    event.requestContext.http.userAgent = '';
    event.body = JSON.stringify({
      slack: data.event,
      message: data.event.text
        .replace(/^<@[^>]+>/g, '')
        .trim(),
    });

    await lambda
      .invoke({
        InvocationType: 'Event',
        FunctionName: context.functionName,
        Payload: JSON.stringify(event),
      })
      .promise();

      console.log('Slack: 非同期Lambdaを起動しました');
      return { statusCode: 200 };
  }

  event.body = JSON.stringify(data);
  return null;
};

/**
 * [DEBUG] ページのスクリーンショットをS3にアップロードします。
 * @param {Page} page
 * @param {string} key ※拡張子不要
 * @returns {Promise<void>}
 */
const screenshot = async (page, key) => {
  const path = `/tmp/${key}.png`;

  // ※日本語フォントを動的ロード
  await page.addStyleTag({
    content: `
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP&display=swap');
      body {
        font-family: 'Noto Sans JP', sans-serif !important;
      }
    `
  });

  // スクリーンショットを撮ってアップロード
  await page.screenshot({ path });
  await s3
    .putObject({
      Bucket: process.env.SCREENSHOT_BUCKET,
      Key: `${key}.png`,
      Body: await fs.readFile(path),
    })
    .promise();
};

/**
 * [DEBUG] ページのHTMLをS3にアップロードします。
 * @param {Page} page
 * @param {string} key ※拡張子不要
 * @returns {Promise<void>}
 */
const dump = async (page, key) => {
  await s3
    .putObject({
      Bucket: process.env.SCREENSHOT_BUCKET,
      Key: `${key}.html`,
      Body: await page.innerHTML('body'),
    })
    .promise();
};

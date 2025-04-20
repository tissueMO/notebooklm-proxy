import axios from 'axios';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqsClient = new SQSClient();

/**
 * Slackbotからのリクエストを処理します。
 * @param {Object} event
 */
export async function handler(event) {
  const data = JSON.parse(event?.body ?? '{}');

  if (!auth(event)) {
    return { statusCode: 400 };
  }

  switch (data.type ?? '') {
    case 'url_verification':
      console.log('Slackbot: チャレンジリクエスト', data);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: data.challenge,
      };

    case 'event_callback':
      console.log('Slackbot: イベント通知内容', data);

      // SQSキューイング
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: process.env.SQS_QUEUE_URL,
        MessageGroupId: 'slackbot-default',
        MessageDeduplicationId: data.event.ts,
        MessageBody: JSON.stringify({
          slack: data.event,
          message: data.event.text
            .replace(/^<@[^>]+>/g, '')
            .trim(),
        }),
      }));

      // 元スレッドに受理した旨を返信
      await axios.post(process.env.SLACK_WEBHOOK_URL, {
        thread_ts: data.event.ts,
        text: '(NotebookLMに問い合わせ中...)',
      });

      return { statusCode: 200 };
  }

  return { statusCode: 400 };
}

/**
 * リクエストを検証します。
 * @param {Object} event
 * @returns {boolean}
 */
function auth(event) {
  return event.requestContext?.http?.userAgent?.startsWith('Slackbot') || (event.headers?.['x-api-key'] === process.env.API_KEY);
}

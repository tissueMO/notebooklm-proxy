# NotebookLM Proxy

Google の NotebookLM サービスに対してプロキシとして機能する AWS Lambda アプリケーションです。  
API リクエストや Slack からのメッセージを受け取り、NotebookLM に問い合わせて結果を返します。  

## 機能

- NotebookLM への問い合わせを AWS Lambda 経由で実行
- Slack との統合（メッセージの受信と応答）
- API キーによる認証
- Playwright を使用したヘッドレスブラウザによる NotebookLM の操作
- セッション状態の保存と再利用
- スクリーンショットの S3 バケットへの保存（デバッグ用）

## 技術スタック

- Node.js
- AWS Lambda
- AWS SAM (Serverless Application Model)
- Playwright（ヘッドレスブラウザ）
- Docker（開発環境）
- Slack API

## セットアップと設定

### 環境変数

以下の環境変数を `.env` ファイルに設定する必要があります：

```
S3_BUCKET=デプロイ用の S3 バケット名
S3_PREFIX=デプロイ用の S3 プレフィックス
NOTEBOOK_URL=NotebookLM の URL
SCREENSHOT_BUCKET=スクリーンショット保存用の S3 バケット
API_KEY=API 認証キー
GOOGLE_USER_NAME=Google アカウントのユーザー名
GOOGLE_USER_PASSWORD=Google アカウントのパスワード
SLACK_WEBHOOK_URL=Slack の Webhook URL
```

### 開発環境の構築

```bash
docker-compose up -d
```

### デプロイ

```bash
yarn deploy
```

## 使用方法

### API 経由での利用

HTTP POST リクエストを Lambda 関数 URL に送信します。

```
POST https://your-lambda-function-url/
Headers:
  x-api-key: YOUR_API_KEY
Body:
  {
    "message": "NotebookLM への問い合わせ内容"
  }
```

### Slack 経由での利用

Slack アプリを設定し、ボットユーザーにメンションすることで NotebookLM に問い合わせることができます。

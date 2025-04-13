#!/bin/bash

source .env

sam build

sam package \
  --region ap-northeast-1 \
  --s3-bucket $S3_BUCKET \
  --s3-prefix $S3_PREFIX

sam deploy \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM \
  --stack-name notebooklm-proxy \
  --s3-bucket $S3_BUCKET \
  --s3-prefix $S3_PREFIX \
  --parameter-overrides \
    ParameterKey=NotebookUrl,ParameterValue="$NOTEBOOK_URL" \
    ParameterKey=ScreenshotBucket,ParameterValue="$SCREENSHOT_BUCKET" \
    ParameterKey=ApiKey,ParameterValue="$API_KEY" \
    ParameterKey=GoogleUserName,ParameterValue="$GOOGLE_USER_NAME" \
    ParameterKey=GoogleUserPassword,ParameterValue="$GOOGLE_USER_PASSWORD" \
    ParameterKey=SlackWebhookUrl,ParameterValue="$SLACK_WEBHOOK_URL"

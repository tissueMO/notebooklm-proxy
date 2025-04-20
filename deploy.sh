#!/bin/bash

source .env

sam build

sam package \
  --region ap-northeast-1 \
  --s3-bucket $S3_BUCKET \
  --s3-prefix deploy

sam deploy \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM \
  --stack-name notebooklm-proxy \
  --s3-bucket $S3_BUCKET \
  --s3-prefix deploy \
  --parameter-overrides \
    ParameterKey=S3Bucket,ParameterValue="$S3_BUCKET" \
    ParameterKey=ApiKey,ParameterValue="$API_KEY" \
    ParameterKey=SlackWebhookUrl,ParameterValue="$SLACK_WEBHOOK_URL"

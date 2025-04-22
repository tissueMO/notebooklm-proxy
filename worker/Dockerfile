# 開発ステージ
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS dev

# 日本語対応
RUN apt-get update && \
    apt-get -y --no-install-recommends install locales language-pack-ja fonts-ipafont-gothic fonts-ipafont-mincho && \
    echo "ja_JP UTF-8" > /etc/locale.gen && \
    locale-gen && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=development

WORKDIR /app
CMD ["bash"]

# 本番ステージ
FROM dev AS prod

ADD . /app
RUN yarn install

ENV NODE_ENV=production

CMD ["yarn", "start"]

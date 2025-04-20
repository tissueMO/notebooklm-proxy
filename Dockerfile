FROM node:22-bullseye

RUN apt-get update && \
    apt-get install -y unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN curl -L -o aws-sam.zip https://github.com/aws/aws-sam-cli/releases/latest/download/aws-sam-cli-linux-x86_64.zip && \
    unzip aws-sam.zip -d /tmp/aws-sam && \
    rm aws-sam.zip && \
    /tmp/aws-sam/install && \
    sam --version

USER node
WORKDIR /app

CMD ["bash"]

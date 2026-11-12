# CLOSE INTELLIGENCE — container image. Not built or run as part of verification.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY samples ./samples
ENV CI_DATA_DIR=/data PORT=4600 CI_SECURE_COOKIES=1 CI_TRUST_PROXY=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4600
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

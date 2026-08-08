FROM docker.1ms.run/library/node:22.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN groupadd --system --gid 10003 actiongateway \
  && useradd --system --uid 10003 --gid actiongateway --home-dir /var/lib/action-gateway actiongateway

USER 10003:10003
EXPOSE 8082

CMD ["node", "src/server.mjs"]

FROM docker.1ms.run/library/node:22.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN groupadd --system --gid 10004 knowledgeconnector \
  && useradd --system --uid 10004 --gid knowledgeconnector --home-dir /var/lib/knowledge-connector knowledgeconnector

USER 10004:10004
EXPOSE 8083

CMD ["node", "src/server.mjs"]

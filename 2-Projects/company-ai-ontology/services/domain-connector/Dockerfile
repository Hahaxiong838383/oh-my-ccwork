FROM docker.1ms.run/library/node:22.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

RUN groupadd --system --gid 10005 domainconnector \
  && useradd --system --uid 10005 --gid domainconnector --home-dir /var/lib/domain-connector domainconnector

USER 10005:10005
EXPOSE 8085

CMD ["node", "src/server.mjs"]

FROM docker.1ms.run/library/node:22.19.0-bookworm-slim

ARG ONTOLOGY_SOURCE_COMMIT=unknown
ENV NODE_ENV=production \
    ONTOLOGY_SOURCE_COMMIT=${ONTOLOGY_SOURCE_COMMIT}
LABEL org.opencontainers.image.revision=${ONTOLOGY_SOURCE_COMMIT}
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY prompts ./prompts

RUN groupadd --system --gid 10001 agentcore \
  && useradd --system --uid 10001 --gid agentcore --home-dir /var/lib/company-agent agentcore \
  && mkdir -p /var/lib/company-agent/home /var/lib/company-agent/workspace \
  && chown -R agentcore:agentcore /var/lib/company-agent

USER 10001:10001
EXPOSE 8080

CMD ["node", "src/server.mjs"]

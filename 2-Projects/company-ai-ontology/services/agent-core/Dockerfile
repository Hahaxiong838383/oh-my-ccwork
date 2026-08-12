FROM docker.1ms.run/library/node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

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
  && chmod -R a+rX /app \
  && chown -R agentcore:agentcore /var/lib/company-agent

USER 10001:10001
EXPOSE 8080

CMD ["node", "src/server.mjs"]

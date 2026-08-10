FROM node:22.14.0-alpine3.21@sha256:9bef0ef1e268f60627da9ba7d7605e8831d5b56ad07487d24d1aa386336d1944

ARG SOURCE_COMMIT=uncommitted

LABEL org.opencontainers.image.title="Futurus Company Intelligence Collector" \
  org.opencontainers.image.version="0.1.0" \
  org.opencontainers.image.source="company-ai-ontology" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}"

WORKDIR /opt/company-ai-ontology

COPY packages/ontology-contracts ./packages/ontology-contracts
COPY services/intelligence-collector ./services/intelligence-collector

RUN addgroup -S intelligence && adduser -S -G intelligence intelligence \
  && mkdir -p /var/lib/company-intelligence/state /var/lib/company-intelligence/reports /etc/company-intelligence \
  && chown -R intelligence:intelligence /var/lib/company-intelligence /etc/company-intelligence

USER intelligence
WORKDIR /opt/company-ai-ontology/services/intelligence-collector

ENV NODE_ENV=production
ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["run", "--config", "/etc/company-intelligence/config.json"]

FROM docker.1ms.run/library/node:22.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY packages/ontology-contracts ./packages/ontology-contracts
COPY services/ontology-registry/package.json services/ontology-registry/package-lock.json ./services/ontology-registry/
WORKDIR /app/services/ontology-registry
RUN npm ci --omit=dev && npm cache clean --force

COPY services/ontology-registry/src ./src

RUN groupadd --system --gid 10004 ontologyregistry \
  && useradd --system --uid 10004 --gid ontologyregistry --home-dir /var/lib/ontology-registry ontologyregistry \
  && mkdir -p /var/lib/ontology-registry \
  && chown -R ontologyregistry:ontologyregistry /var/lib/ontology-registry

USER 10004:10004
EXPOSE 8084

CMD ["node", "src/server.mjs"]

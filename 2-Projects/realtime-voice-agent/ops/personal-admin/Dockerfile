FROM public.ecr.aws/docker/library/node:24.19.0-bookworm-slim
WORKDIR /app
COPY server.mjs index.html whitebox.html whitebox.js whitebox.css design.html event-property-schema-v1.json ./
USER 1000:1001
CMD ["node","server.mjs"]

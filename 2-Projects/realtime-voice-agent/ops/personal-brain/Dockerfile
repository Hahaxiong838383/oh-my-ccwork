FROM public.ecr.aws/docker/library/node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
WORKDIR /app
COPY server.mjs verify.mjs weather-places.json ./
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server.mjs"]

FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN addgroup -S runner \
    && adduser -S -G runner runner \
    && mkdir -p /var/lib/aiops-tool-runner/audit \
    && chown -R runner:runner /var/lib/aiops-tool-runner

WORKDIR /app
COPY policy.py /app/policy.py
COPY server.py /app/server.py

USER runner
CMD ["python", "/app/server.py"]

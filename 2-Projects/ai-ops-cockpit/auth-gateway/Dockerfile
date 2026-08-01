FROM python:3.12-alpine

WORKDIR /app
COPY server.py /app/server.py

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).read()"

CMD ["python", "/app/server.py"]

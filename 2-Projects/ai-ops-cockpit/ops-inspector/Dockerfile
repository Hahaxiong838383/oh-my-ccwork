FROM python:3.12-alpine
RUN apk add --no-cache docker-cli openssh-client
WORKDIR /app
COPY server.py /app/server.py
COPY ops_tool_runtime.py /app/ops_tool_runtime.py
CMD ["python", "/app/server.py"]

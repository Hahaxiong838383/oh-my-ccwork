FROM python:3.12-alpine
RUN apk add --no-cache bash docker-cli openssh-client ripgrep rsync
WORKDIR /app
COPY server.py /app/server.py
COPY ops_tool_runtime.py /app/ops_tool_runtime.py
COPY task_lifecycle.py /app/task_lifecycle.py
COPY self_monitor.py /app/self_monitor.py
CMD ["python", "/app/server.py"]

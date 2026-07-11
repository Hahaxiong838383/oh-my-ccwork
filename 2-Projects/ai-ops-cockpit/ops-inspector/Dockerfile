FROM python:3.12-alpine
RUN apk add --no-cache docker-cli openssh-client
WORKDIR /app
COPY server.py /app/server.py
CMD ["python", "/app/server.py"]

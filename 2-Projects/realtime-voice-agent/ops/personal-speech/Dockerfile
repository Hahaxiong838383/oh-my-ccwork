FROM public.ecr.aws/docker/library/python:3.11-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir sherpa-onnx==1.13.3 aiohttp==3.11.18
WORKDIR /app
COPY server.py /app/server.py
RUN groupadd --gid 1000 speech \
    && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin speech
USER 1000:1000
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    ASR_MODEL_DIR=/models/asr \
    TTS_MODEL_DIR=/models/tts \
    TTS_SID=0 \
    TTS_VOICE=piper-zh-huayan-medium \
    VOICES_DIR=/models/voices \
    VOICE_STATE_PATH=/state/active.json \
    BIND=0.0.0.0 \
    PORT=8091
EXPOSE 8091
CMD ["python", "-u", "/app/server.py"]

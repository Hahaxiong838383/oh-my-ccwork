FROM personal-voice-worker-core:20261125
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    HOME=/var/cache/personal-voice \
    VAD_MODEL_PATH=/opt/voice/assets/silero_vad.onnx \
    EOT_SIDECAR_PYTHON=/opt/voice/venv/bin/python \
    EOT_SIDECAR_SCRIPT=/opt/voice/eot_sidecar.py \
    EOT_SOCK=/tmp/eot.sock \
    AGENT_NAME=personal-xiaoke \
    SPEAKER_ID_ENABLED=0
COPY edge-ca.crt /usr/local/share/ca-certificates/personal-edge-pilot.crt
RUN update-ca-certificates
COPY eot_sidecar.py /opt/voice/eot_sidecar.py
COPY silero_vad.onnx /opt/voice/assets/silero_vad.onnx
COPY voice-rust-worker /usr/local/bin/voice-rust-worker
RUN install -d -o 1000 -g 1000 -m 0700 /var/cache/personal-voice \
 && chmod 0755 /usr/local/bin/voice-rust-worker
USER 1000:1000
WORKDIR /var/cache/personal-voice
ENTRYPOINT ["/usr/local/bin/voice-rust-worker"]

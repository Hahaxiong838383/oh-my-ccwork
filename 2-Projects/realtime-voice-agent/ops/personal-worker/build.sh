#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
: "${VOICE_EDGE_CA:?provide the public Beijing pilot CA certificate}"
bin=${VOICE_WORKER_BINARY:-$root/rust-worker/target/release/voice-rust-worker}
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
if ! docker image inspect personal-voice-worker-core:20261125 >/dev/null 2>&1; then
    mkdir "$stage/wheels"
    # The runtime uses the native EOT package directly. Wheels match the target
    # Ubuntu image's Python 3.12 / amd64 ABI, independent of the host pip.
    python3 -m pip download --only-binary=:all: --python-version 312 --implementation cp --abi cp312 \
      --platform manylinux_2_28_x86_64 --platform manylinux2014_x86_64 --dest "$stage/wheels" \
      'livekit-local-inference==0.2.5' 'livekit==1.1.9' 'livekit-api==1.2.3' 'numpy==2.5.5'
    docker build -f "$here/Dockerfile.runtime" -t personal-voice-worker-core:20261125 "$stage"
    rm -r "$stage/wheels"
fi
install -m 0644 "$VOICE_EDGE_CA" "$stage/edge-ca.crt"
install -m 0755 "$bin" "$stage/voice-rust-worker"
install -m 0644 "$root/rust-worker/sidecar/eot_sidecar.py" "$root/rust-worker/assets/silero_vad.onnx" "$here/Dockerfile" "$stage/"
tag=$(sha256sum "$bin" | cut -c1-12)
docker build -t "personal-voice-worker:$tag" "$stage"
docker run --rm --entrypoint /opt/voice/venv/bin/python "personal-voice-worker:$tag" -c 'from livekit import local_inference as li; li.init_eot(); print(type(li.EOT()).__name__)'

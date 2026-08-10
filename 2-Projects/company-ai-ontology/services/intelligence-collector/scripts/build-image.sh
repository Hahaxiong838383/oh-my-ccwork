#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
SOURCE_COMMIT=${SOURCE_COMMIT:-$(git -C "$PROJECT_ROOT/../.." rev-parse HEAD)}
IMAGE_TAG=${IMAGE_TAG:-company-intelligence-collector:0.1.0}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build the collector image" >&2
  exit 1
fi

docker build \
  --file "$PROJECT_ROOT/services/intelligence-collector/Dockerfile" \
  --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
  --tag "$IMAGE_TAG" \
  "$PROJECT_ROOT"

docker image inspect "$IMAGE_TAG" --format '{{json .RepoDigests}}'

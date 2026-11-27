#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source_dir="$here/../../../P003GameDemo20260513/apps/server"
build="${BRAIN_WORK_DIR:-$here/.build}"
context="$build/context"
: "${BRAIN_BUILD:?set an image tag}"
mkdir -p "$build/deps" "$context"
cp "$source_dir/"{package.json,package-lock.json} "$build/deps/"
npm ci --prefix "$build/deps" --cache "$build/npm-cache" --ignore-scripts --no-audit --no-fund
cp "$here/"{server.ts,upstream.ts,providers.ts,voice-progress.ts,public-queries.ts,weather-fallback.ts,market-news.ts,memory-actions.ts,memory-recall.ts,story-feedback.ts,personal-style.ts,brief-speech.ts} "$build/"
cp "$source_dir/package.json" "$build/package.json"
ln -sfn deps/node_modules "$build/node_modules"
python3 "$here/stage.py" "$source_dir/src" "$build/p003"
"$build/node_modules/.bin/tsc" --noEmit --target es2023 --module nodenext --skipLibCheck --strict --typeRoots "$build/deps/node_modules/@types" "$build/server.ts"
NODE_PATH="$build/deps/node_modules" "$build/deps/node_modules/.bin/esbuild" "$build/server.ts" \
  --bundle --platform=node --format=esm --target=node24 --drop:console \
  --banner:js="import { createRequire } from 'node:module';const require=createRequire(import.meta.url);" \
  --metafile="$build/imports.json" --outfile="$context/server.mjs"
python3 - "$build/imports.json" <<'PY'
import json, sys
paths = json.load(open(sys.argv[1]))['inputs']
for path in paths:
    if '/p003/' in path:
        assert not any(part in path for part in ('/ark/', '/routes/', '/providers/', 'auth-jwt', 'xiaoke-kb', 'device-registry')), path
PY
cp "$here/"{Dockerfile,verify.mjs} "$context/"
cp "$source_dir/src/tools/weather-places.json" "$context/"
docker build --pull=false -t "personal-brain:$BRAIN_BUILD" "$context"

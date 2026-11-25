#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
server="$here/../../../P003GameDemo20260513/apps/server"
deps=${SERVER_NODE_MODULES:-$server/node_modules}
: "${ADMIN_BUILD:?set release identifier}"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
NODE_PATH="$deps" "$deps/.bin/esbuild" "$here/server.ts" --bundle --platform=node --format=esm --target=node24 --banner:js="import { createRequire } from 'node:module';const require=createRequire(import.meta.url);" --outfile="$stage/server.mjs"
cp "$server/src/analytics/event-property-schema-v1.json" "$stage/"
cp "$here/index.html" "$here/Dockerfile" "$stage"
python3 - "$here/../../docs/personal-voice-design" "$stage/design.html" <<'PYTHON'
from pathlib import Path
import sys
src, target = map(Path, sys.argv[1:])
page = (src / "index.html").read_text()
style = '<link rel="stylesheet" href="./styles.css" />'
script = '<script src="./app.js"></script>'
assert page.count(style) == page.count(script) == 1
target.write_text(page.replace(style, "<style>" + (src / "styles.css").read_text() + "</style>")
                      .replace(script, "<script>" + (src / "app.js").read_text() + "</script>"))
PYTHON
docker build -t "personal-voice-admin:$ADMIN_BUILD" "$stage"

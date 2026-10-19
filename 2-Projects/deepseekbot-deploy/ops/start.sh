#!/bin/sh
set -eu
umask 077
BASE=/Users/rayman.chen/local/deepseekbot
export PATH="$BASE/node_modules/.bin:/Users/rayman.chen/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export DSH_HOME="$BASE/data"
export DSH_PERMISSION_MODE=workspace-write
export BOTHARNESS_TELEMETRY=0
export BOTHARNESS_CLIENT_DIAGNOSTICS=0
. "$BASE/direct-env.sh"
cd "$BASE/workspace"
exec /Users/rayman.chen/.hermes/node/bin/node "$BASE/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile deepseekbot --host 127.0.0.1 --port 31980 --no-open --public-url https://cli4.hahaxiong.cc/deepseekbot/ --trusted-host cli4.hahaxiong.cc

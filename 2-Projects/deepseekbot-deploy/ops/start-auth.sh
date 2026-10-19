#!/bin/sh
set -eu
umask 077
BASE=/Users/rayman.chen/local/deepseekbot
. "$BASE/direct-env.sh"
exec /Users/rayman.chen/.hermes/node/bin/node "$BASE/auth/gateway.mjs" "$@"

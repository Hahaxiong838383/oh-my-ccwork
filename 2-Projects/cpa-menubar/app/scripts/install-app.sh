#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
"$ROOT/scripts/build-app.sh"
ditto "$ROOT/dist/CPA Menu.app" "/Applications/CPA Menu.app"
open "/Applications/CPA Menu.app"

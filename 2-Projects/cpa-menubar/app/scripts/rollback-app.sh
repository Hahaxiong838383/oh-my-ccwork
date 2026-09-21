#!/bin/zsh
set -euo pipefail

BACKUP_ROOT="${0:A:h}"
TARGET_APP="/Applications/CPA Menu.app"
SOURCE_APP="$BACKUP_ROOT/CPA Menu.app"
MODE="${1:-apply}"

[[ "$MODE" == "apply" || "$MODE" == "--verify-only" ]] || exit 2
[[ -d "$SOURCE_APP" && -f "$BACKUP_ROOT/binary.sha256" ]] || exit 1
EXPECTED_SHA="$(cat "$BACKUP_ROOT/binary.sha256")"
ACTUAL_SHA="$(shasum -a 256 "$SOURCE_APP/Contents/MacOS/CPAMenuBar" | awk '{print $1}')"
[[ "$EXPECTED_SHA" == "$ACTUAL_SHA" ]] || { echo "backup checksum mismatch" >&2; exit 1; }
codesign --verify --strict "$SOURCE_APP"
if [[ "$MODE" == "--verify-only" ]]; then
  echo "rollback backup verified: $BACKUP_ROOT"
  exit 0
fi

STAGE_ROOT="$(mktemp -d '/Applications/.cpa-menu-rollback.XXXXXX')"
ditto "$SOURCE_APP" "$STAGE_ROOT/CPA Menu.app"
codesign --verify --strict "$STAGE_ROOT/CPA Menu.app"
for process_id in ${(f)"$(pgrep -x CPAMenuBar || true)"}; do
  [[ -n "$process_id" ]] || continue
  command_path="$(ps -p "$process_id" -o comm= 2>/dev/null || true)"
  [[ "$command_path" == "$TARGET_APP/Contents/MacOS/CPAMenuBar" ]] || continue
  kill -TERM "$process_id"
  for attempt in {1..30}; do
    kill -0 "$process_id" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$process_id" 2>/dev/null; then
    echo "installed app did not terminate; rollback not applied" >&2
    exit 1
  fi
done

if [[ -e "$TARGET_APP" ]]; then
  mv "$TARGET_APP" "$STAGE_ROOT/replaced.app"
fi
if ! mv "$STAGE_ROOT/CPA Menu.app" "$TARGET_APP"; then
  [[ ! -e "$STAGE_ROOT/replaced.app" ]] || mv "$STAGE_ROOT/replaced.app" "$TARGET_APP"
  exit 1
fi
if [[ -e "$STAGE_ROOT/replaced.app" ]]; then
  ditto "$STAGE_ROOT/replaced.app" "$BACKUP_ROOT/replaced-at-$(date -u '+%Y%m%d-%H%M%S').app"
fi
open "$TARGET_APP" --args --show-panel
python3 - "$STAGE_ROOT" <<'PY'
import shutil, sys
from pathlib import Path
directory = Path(sys.argv[1])
assert directory.parent == Path('/Applications') and directory.name.startswith('.cpa-menu-rollback.')
shutil.rmtree(directory)
PY
echo "rollback applied; credentials and preferences unchanged"

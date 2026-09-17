#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
CODEX_CONFIG_DIR="${CODEX_HOME:-$HOME/.codex}"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
GUI_PATH="$HOME/local/node/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REFRESH_LABEL="com.rayman.codex-refresh-model-catalog"
PATH_LABEL="com.rayman.codex-gui-path"

[[ -x "$HOME/local/node/bin/node" ]] || { echo "missing Air Node runtime" >&2; exit 1; }
install -d -m 700 "$CODEX_CONFIG_DIR" "$CODEX_CONFIG_DIR/logs" "$CODEX_CONFIG_DIR/backups"
install -d -m 755 "$LAUNCH_AGENTS"
BACKUP_DIR="$(mktemp -d "$CODEX_CONFIG_DIR/backups/runtime-guard-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
for source_file in \
  "$CODEX_CONFIG_DIR/refresh-cc-switch-model-catalog.mjs" \
  "$CODEX_CONFIG_DIR/ensure-gui-cli-path.sh" \
  "$LAUNCH_AGENTS/$PATH_LABEL.plist" \
  "$LAUNCH_AGENTS/$REFRESH_LABEL.plist"; do
  if [[ -f "$source_file" ]]; then
    cp -p "$source_file" "$BACKUP_DIR/"
  fi
done
for label in "$PATH_LABEL" "$REFRESH_LABEL"; do
  /bin/launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
done
install -m 700 "$ROOT/scripts/refresh-cc-switch-model-catalog.mjs" \
  "$CODEX_CONFIG_DIR/refresh-cc-switch-model-catalog.mjs"

cat > "$CODEX_CONFIG_DIR/ensure-gui-cli-path.sh" <<EOF
#!/bin/zsh
exec /bin/launchctl setenv PATH '$GUI_PATH'
EOF
chmod 700 "$CODEX_CONFIG_DIR/ensure-gui-cli-path.sh"

cat > "$LAUNCH_AGENTS/$PATH_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PATH_LABEL</string>
  <key>ProgramArguments</key><array><string>$CODEX_CONFIG_DIR/ensure-gui-cli-path.sh</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF

cat > "$LAUNCH_AGENTS/$REFRESH_LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$REFRESH_LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/local/node/bin/node</string>
    <string>$CODEX_CONFIG_DIR/refresh-cc-switch-model-catalog.mjs</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>$CODEX_CONFIG_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$CODEX_CONFIG_DIR/logs/refresh-model-catalog.log</string>
  <key>StandardErrorPath</key><string>$CODEX_CONFIG_DIR/logs/refresh-model-catalog.err.log</string>
</dict></plist>
EOF

/bin/launchctl setenv PATH "$GUI_PATH"
refresh_result=0
"$HOME/local/node/bin/node" "$CODEX_CONFIG_DIR/refresh-cc-switch-model-catalog.mjs" || refresh_result=$?
for label in "$PATH_LABEL" "$REFRESH_LABEL"; do
  /bin/launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENTS/$label.plist"
done

echo "installed Air Codex runtime guard; backup=$BACKUP_DIR; initial_refresh_exit=$refresh_result"
exit "$refresh_result"

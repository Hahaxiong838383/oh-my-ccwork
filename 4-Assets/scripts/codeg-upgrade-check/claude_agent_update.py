"""Update the enabled Claude ACP adapter through the local Codeg server."""
import http.client
import json
import os
from pathlib import Path
import re
import uuid

AGENT = "claude_code"
PACKAGE = "@agentclientprotocol/claude-agent-acp"


def rpc(command, **params):
    token = (Path.home() / ".local/share/codeg/token").read_text().strip()
    connection = http.client.HTTPConnection("127.0.0.1", 3080, timeout=1200)
    try:
        connection.request("POST", "/api/" + command, json.dumps(params), {
            "Content-Type": "application/json", "Authorization": "Bearer " + token,
        })
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError(f"{command}: HTTP {response.status}")
        return json.load(response)
    finally:
        connection.close()


def npm_install_running():
    for path in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            if path.stat().st_uid != os.getuid():
                continue
            args = path.read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except (PermissionError, FileNotFoundError, ProcessLookupError):
            continue
        if re.search(r"(?:^|/)npm(?:-cli\.js)? (?:install|i|update|uninstall) ", args) and PACKAGE in args:
            return True
    return False


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise ValueError("Codeg did not return a stable adapter version")
    return tuple(map(int, value.split(".")))


def main():
    if not rpc("acp_get_agent_status", agentType=AGENT)["enabled"]:
        print("Claude Code is disabled")
        return
    if npm_install_running():
        print("Deferred: Claude adapter installation in progress")
        return
    local = rpc("acp_detect_agent_local_version", agentType=AGENT)
    latest = rpc("acp_fetch_agent_latest_release", agentType=AGENT)["version"]
    target = version(latest)
    if local is not None and version(local) >= target:
        print(f"Claude adapter installed {local}, release {latest}")
        return
    connections = rpc("acp_list_connections")
    if any(c["agent_type"] == AGENT and c["status"] not in {"connected", "disconnected"}
           for c in connections) or npm_install_running():
        print("Deferred: Claude session or installation busy")
        return
    rpc("acp_prepare_npx_agent", agentType=AGENT, version=latest,
        cleanFirst=False, taskId=f"claude-update-{uuid.uuid4()}")
    installed = rpc("acp_detect_agent_local_version", agentType=AGENT)
    if installed != latest:
        raise RuntimeError(f"Expected {latest}, detected {installed}")
    print(f"Claude adapter updated from {local} to {installed}")


if __name__ == "__main__":
    main()

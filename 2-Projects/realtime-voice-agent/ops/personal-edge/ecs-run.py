"""Run a non-secret maintenance script on the verified Beijing instance."""
import argparse
import json
import subprocess
import sys
import time

INSTANCE = "i-2zeg6on7idgp8zggi1jv"
BASE = [
    "aliyun", "ecs",
]


def api(operation, *args):
    cli = BASE + [
        operation, "--profile", "cc-remote", "--region", "cn-beijing",
        "--RegionId", "cn-beijing",
    ]
    result = subprocess.run(cli + list(args), check=True, stdout=subprocess.PIPE)
    return json.loads(result.stdout)


def execute(script, name, timeout):
    result = api(
        "RunCommand", "--InstanceId.1", INSTANCE, "--Type", "RunShellScript",
        "--Name", "personal-edge-" + name, "--ContentEncoding", "PlainText",
        "--CommandContent", script, "--Timeout", str(timeout), "--KeepCommand", "false",
    )
    invoke = result["InvokeId"]
    for _ in range(timeout + 15):
        reply = api(
            "DescribeInvocationResults", "--InstanceId", INSTANCE,
            "--InvokeId", invoke, "--ContentEncoding", "PlainText",
        )
        rows = reply["Invocation"]["InvocationResults"]["InvocationResult"]
        if rows and rows[0]["InvocationStatus"] not in {"Pending", "Running", "Scheduled"}:
            row = rows[0]
            if row["InvocationStatus"] == "Success" and row.get("ExitCode") == 0:
                sys.stdout.write(row.get("Output", ""))
                return
            sys.stderr.write(row.get("Output", ""))
            raise SystemExit(f"{invoke} {row['InvocationStatus']} exit={row.get('ExitCode')}")
        time.sleep(1)
    raise SystemExit(f"{invoke} has no terminal result")


if __name__ == "__main__":
    cli = argparse.ArgumentParser()
    cli.add_argument("name")
    cli.add_argument("--timeout", type=int, default=30)
    args = cli.parse_args()
    execute(sys.stdin.read(), args.name, args.timeout)

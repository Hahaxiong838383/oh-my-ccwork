import os
import secrets
import time


RISK_READONLY = "readonly"
RISK_CONFIRM = "confirm"
RISK_BLOCKED = "blocked"


def utcish_now():
    return time.strftime("%Y-%m-%d %H:%M:%S %Z")


def tool_specs(projects):
    project_ids = sorted(projects.keys())
    return [
        {
            "name": "list-project-profile",
            "title": "查看项目 Profile",
            "description": "返回项目 allowlist、生产通道、可用动作和风险摘要。",
            "risk": RISK_READONLY,
            "permission": "read_token",
            "projects": project_ids,
            "schema": {"project": "string"},
        },
        {
            "name": "inspect-live-probes",
            "title": "公网只读探测",
            "description": "执行项目公开入口探测，返回状态、耗时和失败项。",
            "risk": RISK_READONLY,
            "permission": "read_token",
            "projects": project_ids,
            "schema": {"project": "string"},
        },
        {
            "name": "inspect-production-channel",
            "title": "生产限权巡检",
            "description": "通过专用限权通道执行 inspect，只返回脱敏生产状态。",
            "risk": RISK_READONLY,
            "permission": "read_token",
            "projects": project_ids,
            "schema": {"project": "string"},
        },
        {
            "name": "inspect-latest-production-record",
            "title": "读取最近生产记录",
            "description": "读取最近一次生产维护审计记录，不触发远端命令。",
            "risk": RISK_READONLY,
            "permission": "read_token",
            "projects": project_ids,
            "schema": {"project": "string"},
        },
        {
            "name": "run-controlled-action",
            "title": "确认后执行受控动作",
            "description": "复用既有限权维护通道；必须 action token、确认词、冷却和动作后验收。",
            "risk": RISK_CONFIRM,
            "permission": "action_token",
            "projects": project_ids,
            "schema": {"project": "string", "action": "string", "confirmation": "string"},
        },
        {
            "name": "deploy-or-shell",
            "title": "部署或任意 Shell",
            "description": "明确禁止；Grok 不获得 shell、部署、文件写入或 secret 读取能力。",
            "risk": RISK_BLOCKED,
            "permission": "blocked",
            "projects": project_ids,
            "schema": {},
        },
    ]


def project_profiles(projects, allowlists, live_probes, allowed_actions_fn, label_fn, confirmation_fn, configured_fn):
    profiles = []
    for project_id in sorted(projects.keys()):
        project = projects[project_id]
        production = project.get("production") or {}
        actions = allowed_actions_fn(project_id)
        profiles.append({
            "id": project_id,
            "name": project.get("name") or project_id,
            "path": project.get("path"),
            "risk": project.get("risk"),
            "goal": project.get("goal"),
            "allowlistCount": len(allowlists.get(project_id) or []),
            "liveProbeCount": len(live_probes.get(project_id) or []),
            "productionConfigured": bool(configured_fn(project_id)),
            "production": {
                "domain": production.get("domain"),
                "processManager": production.get("processManager"),
                "verifiedAt": production.get("verifiedAt"),
            },
            "actions": [
                {
                    "id": action,
                    "label": label_fn(project_id, action),
                    "risk": RISK_READONLY if action == "inspect" else RISK_CONFIRM,
                    "confirmationRequired": bool(confirmation_fn(project_id, action)),
                }
                for action in actions
            ],
        })
    return profiles


def tool_map(projects):
    return {item["name"]: item for item in tool_specs(projects)}


def runtime_summary(projects, executions):
    tools = tool_specs(projects)
    readonly = len([item for item in tools if item["risk"] == RISK_READONLY])
    confirm = len([item for item in tools if item["risk"] == RISK_CONFIRM])
    blocked = len([item for item in tools if item["risk"] == RISK_BLOCKED])
    latest = executions[0] if executions else None
    return {
        "ok": True,
        "name": "ops-tool-runtime",
        "style": "Grok Build inspired",
        "mode": "readonly-first",
        "policy": "allowlist + action token + exact confirmation",
        "toolCount": len(tools),
        "readonlyToolCount": readonly,
        "confirmToolCount": confirm,
        "blockedToolCount": blocked,
        "projectCount": len(projects),
        "latestExecutionId": latest.get("id") if latest else None,
        "generatedAt": utcish_now(),
    }


def execution_dir(state_dir):
    return os.path.join(state_dir, "ops-runtime", "executions")


def execution_id():
    return "ort-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


def summarize_result(result):
    if not isinstance(result, dict):
        return {"ok": False, "kind": type(result).__name__}
    summary = {
        "ok": bool(result.get("ok")),
        "status": result.get("status"),
        "error": result.get("error"),
        "durationMs": result.get("durationMs") or result.get("latencyMs"),
    }
    if "passed" in result or "total" in result:
        summary["passed"] = result.get("passed")
        summary["total"] = result.get("total")
    if "jobId" in result:
        summary["jobId"] = result.get("jobId")
        summary["pollUrl"] = result.get("pollUrl")
    return {key: value for key, value in summary.items() if value is not None}


def make_execution_record(tool, project, risk, request, result, started_ts):
    return {
        "id": execution_id(),
        "tool": tool,
        "project": project,
        "risk": risk,
        "request": {
            key: value
            for key, value in (request or {}).items()
            if key not in ("confirmation", "token", "actionToken", "readToken")
        },
        "resultSummary": summarize_result(result),
        "result": result,
        "durationMs": round((time.time() - started_ts) * 1000),
        "createdAt": utcish_now(),
        "secretExposure": 0,
    }

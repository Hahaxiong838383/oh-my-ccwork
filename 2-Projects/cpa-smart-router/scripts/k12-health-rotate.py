#!/usr/bin/env python3
"""k12 auth health + pool/source rotation for CLIProxyAPI.

整包无 refresh_token，无法 OAuth 刷新。
机制：验活 → 删除死号 → 小池补号 → 大源随机抽样补号。

大源默认：/opt/cliproxy/k12-source/accounts.json
报告不含 token 正文。
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PREFIX = "zz-test-k12-"
DEFAULT_SOURCE = "/opt/cliproxy/k12-source/accounts.ndjson"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sanitize(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-@]+", "_", s or "unknown")[:80]


def load_json(path: Path) -> Any:
    return json.loads(path.read_text())


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def jwt_exp(access_token: str):
    try:
        p = access_token.split(".")[1]
        p += "=" * ((4 - len(p) % 4) % 4)
        payload = json.loads(base64.urlsafe_b64decode(p))
        return payload.get("exp")
    except Exception:
        return None


def probe_token(access_token: str, account_id: str, timeout: float, probe_model: str) -> tuple[bool, str]:
    if not access_token:
        return False, "missing_access_token"
    exp = jwt_exp(access_token)
    if isinstance(exp, (int, float)) and exp < time.time() - 60:
        return False, f"jwt_expired:{int(exp)}"

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "cpa-k12-health/1.1",
    }
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id
        headers["chatgpt-account-id"] = account_id

    try:
        req = urllib.request.Request(
            "https://api.openai.com/v1/me",
            headers={k: v for k, v in headers.items() if k != "Content-Type"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if 200 <= resp.status < 300:
                return True, "openai_me_200"
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return True, "openai_me_429"
    except Exception:
        pass

    for url in (
        "https://chatgpt.com/backend-api/me",
        "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
    ):
        try:
            req = urllib.request.Request(
                url,
                headers={k: v for k, v in headers.items() if k != "Content-Type"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    return True, "chatgpt_me_200"
        except urllib.error.HTTPError as e:
            if e.code == 429:
                return True, "chatgpt_429"
        except Exception:
            continue

    body = json.dumps({"model": probe_model, "input": "ping", "store": False}).encode()
    for url in (
        "https://chatgpt.com/backend-api/codex/responses",
        "https://api.openai.com/v1/responses",
    ):
        try:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if 200 <= resp.status < 300:
                    return True, "responses_200"
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 415, 422):
                try:
                    detail = e.read()[:240].decode("utf-8", "replace").lower()
                except Exception:
                    detail = ""
                if any(x in detail for x in ("unauthorized", "invalid_api_key", "auth", "token_expired", "revoked")):
                    return False, f"responses_{e.code}_auth"
                return True, f"responses_{e.code}_authed"
            if e.code in (401, 403):
                return False, f"responses_{e.code}"
            if e.code == 429:
                return True, "responses_429"
            return False, f"responses_{e.code}"
        except Exception:
            continue
    return False, "all_probes_failed"


def redact(data: dict) -> dict:
    out = dict(data)
    for k in ("access_token", "refresh_token", "id_token"):
        if out.get(k):
            out[k] = f"[redacted len={len(out[k])}]"
    return out


def health_check_file(path: Path, timeout: float, probe_model: str) -> dict:
    try:
        d = load_json(path)
    except Exception as e:
        return {"file": path.name, "ok": False, "reason": f"bad_json:{e}", "email": "", "path": str(path)}
    ok, reason = probe_token(d.get("access_token") or "", d.get("account_id") or "", timeout, probe_model)
    return {
        "file": path.name,
        "email": d.get("email") or "",
        "ok": ok,
        "reason": reason,
        "disabled": bool(d.get("disabled")),
        "path": str(path),
    }


def next_index(auth_dir: Path) -> int:
    nums = []
    for p in auth_dir.glob(f"{PREFIX}*.json"):
        m = re.match(rf"{PREFIX}(\d+)-", p.name)
        if m:
            nums.append(int(m.group(1)))
    return (max(nums) if nums else 0) + 1


def archive_and_delete(path: Path, state_dir: Path, reason: str, subdir: str) -> None:
    dest_dir = state_dir / subdir
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = dest_dir / f"{stamp}-{path.name}"
    try:
        d = load_json(path)
        d = redact(d)
        d["_removed_reason"] = reason
        d["_removed_at"] = now_iso()
        save_json(dest, d)
    except Exception:
        pass
    path.unlink(missing_ok=True)


def load_used_emails(state_dir: Path) -> set[str]:
    path = state_dir / "used-emails.json"
    if not path.exists():
        return set()
    try:
        data = load_json(path)
        if isinstance(data, list):
            return {str(x) for x in data if x}
        if isinstance(data, dict):
            return {str(x) for x in (data.get("emails") or []) if x}
    except Exception:
        return set()
    return set()


def save_used_emails(state_dir: Path, emails: set[str]) -> None:
    # cap growth
    items = sorted(emails)
    if len(items) > 50000:
        items = items[-50000:]
    save_json(state_dir / "used-emails.json", {"emails": items, "updatedAt": now_iso(), "count": len(items)})


def sub2_to_cpa(acc: dict) -> dict | None:
    c = acc.get("credentials") or {}
    access = c.get("access_token") or ""
    if not access:
        return None
    email = c.get("email") or (acc.get("extra") or {}).get("email") or ""
    if not email:
        return None
    pl_exp = jwt_exp(access)
    exp = ""
    if isinstance(pl_exp, (int, float)):
        exp = datetime.fromtimestamp(pl_exp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    elif c.get("expires_at"):
        try:
            exp = datetime.fromtimestamp(int(c["expires_at"]), tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            exp = ""
    return {
        "type": "codex",
        "email": email,
        "account_id": c.get("account_id") or c.get("chatgpt_account_id") or "",
        "access_token": access,
        "refresh_token": c.get("refresh_token") or "",
        "id_token": c.get("id_token") or "",
        "expired": exp,
        "last_refresh": (acc.get("extra") or {}).get("last_refresh") or now_iso(),
        "disabled": False,
    }


def load_source_accounts(source_path: Path) -> list[dict]:
    """Legacy helper: only for small JSON. Prefer iter_source_accounts for large sources."""
    if not source_path.exists():
        return []
    # Never load multi-hundred-MB JSON on 1GB hosts.
    if source_path.stat().st_size > 40 * 1024 * 1024 and source_path.suffix.lower() == ".json":
        return []
    data = load_json(source_path)
    if isinstance(data, dict):
        accs = data.get("accounts") or []
        return [a for a in accs if isinstance(a, dict)]
    if isinstance(data, list):
        return [a for a in data if isinstance(a, dict)]
    return []


def iter_source_accounts(source_path: Path):
    """Stream accounts from NDJSON or refuse giant monolithic JSON."""
    if not source_path.exists():
        return
    if source_path.suffix.lower() in (".ndjson", ".jsonl"):
        with source_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if isinstance(obj, dict):
                    yield obj
        return
    # small json only
    for acc in load_source_accounts(source_path):
        yield acc


def refill_from_pool(
    pool_dir: Path,
    auth_dir: Path,
    state_dir: Path,
    need: int,
    active_emails: set[str],
    used_emails: set[str],
    timeout: float,
    probe_model: str,
) -> list[dict]:
    installed = []
    if need <= 0 or not pool_dir.exists():
        return installed
    idx = next_index(auth_dir)
    for pool_path in sorted(pool_dir.glob("pool-*.json")):
        if need <= 0:
            break
        try:
            d = load_json(pool_path)
        except Exception:
            pool_path.unlink(missing_ok=True)
            continue
        email = d.get("email") or ""
        if not email or email in active_emails:
            pool_path.unlink(missing_ok=True)
            continue
        ok, reason = probe_token(d.get("access_token") or "", d.get("account_id") or "", timeout, probe_model)
        used_emails.add(email)
        if not ok:
            archive_and_delete(pool_path, state_dir, reason, "pool-dead")
            continue
        d["disabled"] = False
        fname = f"{PREFIX}{idx:02d}-{sanitize(email)}.json"
        dest = auth_dir / fname
        save_json(dest, d)
        os.chmod(dest, 0o600)
        pool_path.unlink(missing_ok=True)
        installed.append({"file": fname, "email": email, "probe": reason, "source": "pool"})
        active_emails.add(email)
        idx += 1
        need -= 1
    return installed


def refill_from_bulk_source(
    source_path: Path,
    auth_dir: Path,
    state_dir: Path,
    need: int,
    active_emails: set[str],
    used_emails: set[str],
    timeout: float,
    probe_model: str,
    prefer_front: int,
    max_probe_attempts: int,
) -> list[dict]:
    installed = []
    if need <= 0 or not source_path.exists():
        return installed

    # Stream source; reservoir-sample eligible candidates to avoid huge memory.
    reservoir: list[dict] = []
    seen = 0
    cap = max(max_probe_attempts * 4, 200)
    for acc in iter_source_accounts(source_path):
        c = acc.get("credentials") or {}
        email = (c.get("email") or (acc.get("extra") or {}).get("email") or "").strip()
        if not email or email in active_emails or email in used_emails:
            continue
        if not c.get("access_token"):
            continue
        seen += 1
        if len(reservoir) < cap:
            reservoir.append(acc)
        else:
            j = random.randint(0, seen - 1)
            if j < cap:
                reservoir[j] = acc

    random.shuffle(reservoir)
    idx = next_index(auth_dir)
    attempts = 0
    for acc in reservoir:
        if need <= 0 or attempts >= max_probe_attempts:
            break
        attempts += 1
        cpa = sub2_to_cpa(acc)
        if not cpa:
            continue
        email = cpa["email"]
        used_emails.add(email)
        ok, reason = probe_token(cpa.get("access_token") or "", cpa.get("account_id") or "", timeout, probe_model)
        if not ok:
            continue
        fname = f"{PREFIX}{idx:02d}-{sanitize(email)}.json"
        dest = auth_dir / fname
        save_json(dest, cpa)
        os.chmod(dest, 0o600)
        installed.append(
            {
                "file": fname,
                "email": email,
                "probe": reason,
                "source": "bulk",
                "extra_source": (acc.get("extra") or {}).get("source"),
            }
        )
        active_emails.add(email)
        idx += 1
        need -= 1
    return installed


def collect_status(auth_dir: Path, pool_dir: Path, state_dir: Path, source_path: Path) -> dict:
    files = sorted(auth_dir.glob(f"{PREFIX}*.json"))
    team = list(auth_dir.glob("codex-*-team.json")) + list(auth_dir.glob("*team*.json"))
    xai = list(auth_dir.glob("xai-*.json"))
    pool_n = len(list(pool_dir.glob("pool-*.json"))) if pool_dir.exists() else 0
    source_exists = source_path.exists()
    source_size = source_path.stat().st_size if source_exists else 0
    used = load_used_emails(state_dir)
    last = None
    last_path = state_dir / "last-report.json"
    if last_path.exists():
        try:
            last = load_json(last_path)
        except Exception:
            last = None
    # lightweight account list without tokens
    accounts = []
    for p in files:
        try:
            d = load_json(p)
            accounts.append(
                {
                    "file": p.name,
                    "email": str(d.get("email") or "")[:80],
                    "disabled": bool(d.get("disabled")),
                    "expired": str(d.get("expired") or "")[:40] or None,
                }
            )
        except Exception:
            accounts.append({"file": p.name, "email": "", "disabled": None, "expired": None})
    return {
        "ok": True,
        "generatedAt": now_iso(),
        "k12": {
            "count": len(files),
            "accounts": accounts,
        },
        "teamPresent": bool(team),
        "xaiCount": len(xai),
        "poolRemaining": pool_n,
        "source": {
            "path": str(source_path),
            "exists": source_exists,
            "sizeBytes": source_size,
        },
        "usedEmailCount": len(used),
        "lastReport": {
            "ts": (last or {}).get("ts"),
            "before": (last or {}).get("before"),
            "after_total_k12": (last or {}).get("after_total_k12"),
            "removed": len((last or {}).get("removed") or []),
            "installed_from_pool": len((last or {}).get("installed_from_pool") or []),
            "installed_from_bulk": len((last or {}).get("installed_from_bulk") or []),
        }
        if last
        else None,
        "note": "status has no tokens; bulk source is root-only and never exposed to Grok readonly",
    }


def run(
    auth_dir: Path,
    pool_dir: Path,
    state_dir: Path,
    source_path: Path,
    target: int,
    check_only: bool,
    status_only: bool,
    concurrency: int,
    timeout: float,
    probe_model: str,
    prefer_front: int,
    max_probe_attempts: int,
) -> int:
    state_dir.mkdir(parents=True, exist_ok=True)
    if status_only:
        print(json.dumps(collect_status(auth_dir, pool_dir, state_dir, source_path), ensure_ascii=False, indent=2))
        return 0

    files = sorted(auth_dir.glob(f"{PREFIX}*.json"))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(health_check_file, p, timeout, probe_model) for p in files]
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda x: x.get("file") or "")
    healthy = [r for r in results if r.get("ok")]
    dead = [r for r in results if not r.get("ok")]

    removed: list[dict] = []
    installed_pool: list[dict] = []
    installed_bulk: list[dict] = []
    used_emails = load_used_emails(state_dir)

    if not check_only:
        for r in dead:
            p = Path(r["path"])
            if p.exists():
                archive_and_delete(p, state_dir, r.get("reason") or "probe_failed", "removed")
                removed.append({"file": r["file"], "email": r["email"], "reason": r["reason"]})
                if r.get("email"):
                    used_emails.add(r["email"])

        for r in healthy:
            p = Path(r["path"])
            if not p.exists():
                continue
            d = load_json(p)
            if d.get("disabled"):
                d["disabled"] = False
                save_json(p, d)
            if r.get("email"):
                used_emails.add(r["email"])

        need = max(0, target - len(healthy))
        active_emails = set()
        for p in auth_dir.glob(f"{PREFIX}*.json"):
            try:
                active_emails.add(load_json(p).get("email") or "")
            except Exception:
                pass

        installed_pool = refill_from_pool(
            pool_dir, auth_dir, state_dir, need, active_emails, used_emails, timeout, probe_model
        )
        need = max(0, target - (len(healthy) + len(installed_pool)))
        installed_bulk = refill_from_bulk_source(
            source_path,
            auth_dir,
            state_dir,
            need,
            active_emails,
            used_emails,
            timeout,
            probe_model,
            prefer_front=prefer_front,
            max_probe_attempts=max_probe_attempts,
        )
        save_used_emails(state_dir, used_emails)

    after = sorted(auth_dir.glob(f"{PREFIX}*.json"))
    pool_left = len(list(pool_dir.glob("pool-*.json"))) if pool_dir.exists() else 0
    report = {
        "ok": True,
        "ts": now_iso(),
        "check_only": check_only,
        "target_healthy": target,
        "before": {"total": len(results), "healthy": len(healthy), "dead": len(dead)},
        "removed": removed if not check_only else [],
        "dead_detail": [{"file": r["file"], "email": r["email"], "reason": r["reason"]} for r in dead],
        "healthy": [{"file": r["file"], "email": r["email"], "reason": r["reason"]} for r in healthy],
        "installed_from_pool": installed_pool,
        "installed_from_bulk": installed_bulk,
        "after_total_k12": len(after),
        "pool_remaining": pool_left,
        "source_exists": source_path.exists(),
        "used_email_count": len(used_emails),
        "note": "源包无 refresh_token；机制=验活剔除+小池/大源随机补号，非 OAuth refresh",
    }
    save_json(state_dir / "last-report.json", report)
    with (state_dir / "history.jsonl").open("a") as f:
        f.write(
            json.dumps(
                {
                    "ts": report["ts"],
                    "before_total": len(results),
                    "before_healthy": len(healthy),
                    "removed": len(removed),
                    "installed_pool": len(installed_pool),
                    "installed_bulk": len(installed_bulk),
                    "after_total_k12": len(after),
                    "pool_remaining": pool_left,
                    "check_only": check_only,
                },
                ensure_ascii=False,
            )
            + "\n"
        )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="k12 health + pool/source rotation")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--status-only", action="store_true", help="only emit sanitized status JSON")
    ap.add_argument("--target", type=int, default=int(os.environ.get("K12_TARGET_HEALTHY", "25")))
    ap.add_argument("--auth-dir", default=os.environ.get("CPA_AUTH_DIR", "/root/.cli-proxy-api"))
    ap.add_argument("--pool-dir", default=os.environ.get("K12_POOL_DIR", "/opt/cliproxy/k12-pool"))
    ap.add_argument("--state-dir", default=os.environ.get("K12_STATE_DIR", "/opt/cliproxy/k12-state"))
    ap.add_argument("--source", default=os.environ.get("K12_SOURCE_PATH", DEFAULT_SOURCE))
    ap.add_argument("--concurrency", type=int, default=int(os.environ.get("K12_PROBE_CONCURRENCY", "8")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("K12_PROBE_TIMEOUT", "25")))
    ap.add_argument("--probe-model", default=os.environ.get("K12_PROBE_MODEL", "gpt-5.4-mini"))
    ap.add_argument("--prefer-front", type=int, default=int(os.environ.get("K12_PREFER_FRONT", "2000")))
    ap.add_argument(
        "--max-probe-attempts",
        type=int,
        default=int(os.environ.get("K12_MAX_PROBE_ATTEMPTS", "80")),
        help="max bulk candidates to probe when refilling",
    )
    args = ap.parse_args()
    sys.exit(
        run(
            auth_dir=Path(args.auth_dir),
            pool_dir=Path(args.pool_dir),
            state_dir=Path(args.state_dir),
            source_path=Path(args.source),
            target=args.target,
            check_only=args.check_only,
            status_only=args.status_only,
            concurrency=args.concurrency,
            timeout=args.timeout,
            probe_model=args.probe_model,
            prefer_front=args.prefer_front,
            max_probe_attempts=args.max_probe_attempts,
        )
    )


if __name__ == "__main__":
    main()

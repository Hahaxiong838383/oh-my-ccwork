#!/usr/bin/env python3
"""k12 auth health + pool rotation for CLIProxyAPI.

整包无 refresh_token，无法 OAuth 刷新。
机制：验活 → 删除死号 → 从备用池补到目标数量。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PREFIX = "zz-test-k12-"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sanitize(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._+-@]+", "_", s or "unknown")[:80]


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def save_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def jwt_exp(access_token: str):
    try:
        import base64

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
        "User-Agent": "cpa-k12-health/1.0",
    }
    if account_id:
        headers["ChatGPT-Account-Id"] = account_id
        headers["chatgpt-account-id"] = account_id

    # /v1/me
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


def run(auth_dir: Path, pool_dir: Path, state_dir: Path, target: int, check_only: bool, concurrency: int, timeout: float, probe_model: str) -> int:
    state_dir.mkdir(parents=True, exist_ok=True)
    files = sorted(auth_dir.glob(f"{PREFIX}*.json"))
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = [ex.submit(health_check_file, p, timeout, probe_model) for p in files]
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())
    results.sort(key=lambda x: x.get("file") or "")
    healthy = [r for r in results if r.get("ok")]
    dead = [r for r in results if not r.get("ok")]

    removed, installed = [], []
    if not check_only:
        for r in dead:
            p = Path(r["path"])
            if p.exists():
                archive_and_delete(p, state_dir, r.get("reason") or "probe_failed", "removed")
                removed.append({"file": r["file"], "email": r["email"], "reason": r["reason"]})

        for r in healthy:
            p = Path(r["path"])
            if not p.exists():
                continue
            d = load_json(p)
            if d.get("disabled"):
                d["disabled"] = False
                save_json(p, d)

        need = max(0, target - len(healthy))
        active_emails = set()
        for p in auth_dir.glob(f"{PREFIX}*.json"):
            try:
                active_emails.add(load_json(p).get("email") or "")
            except Exception:
                pass
        idx = next_index(auth_dir)
        for pool_path in sorted(pool_dir.glob("pool-*.json")) if pool_dir.exists() else []:
            if need <= 0:
                break
            try:
                d = load_json(pool_path)
            except Exception:
                pool_path.unlink(missing_ok=True)
                continue
            email = d.get("email") or ""
            if email in active_emails:
                pool_path.unlink(missing_ok=True)
                continue
            ok, reason = probe_token(d.get("access_token") or "", d.get("account_id") or "", timeout, probe_model)
            if not ok:
                archive_and_delete(pool_path, state_dir, reason, "pool-dead")
                continue
            d["disabled"] = False
            fname = f"{PREFIX}{idx:02d}-{sanitize(email)}.json"
            dest = auth_dir / fname
            save_json(dest, d)
            os.chmod(dest, 0o600)
            pool_path.unlink(missing_ok=True)
            installed.append({"file": fname, "email": email, "probe": reason})
            active_emails.add(email)
            idx += 1
            need -= 1

    after = sorted(auth_dir.glob(f"{PREFIX}*.json"))
    pool_left = len(list(pool_dir.glob("pool-*.json"))) if pool_dir.exists() else 0
    report = {
        "ts": now_iso(),
        "check_only": check_only,
        "target_healthy": target,
        "before": {"total": len(results), "healthy": len(healthy), "dead": len(dead)},
        "removed": removed if not check_only else [],
        "dead_detail": [{"file": r["file"], "email": r["email"], "reason": r["reason"]} for r in dead],
        "healthy": [{"file": r["file"], "email": r["email"], "reason": r["reason"]} for r in healthy],
        "installed_from_pool": installed,
        "after_total_k12": len(after),
        "pool_remaining": pool_left,
        "note": "源包无 refresh_token；机制=验活剔除+池补号，非 OAuth refresh",
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
                    "installed": len(installed),
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
    ap = argparse.ArgumentParser(description="k12 health + pool rotation")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--target", type=int, default=int(os.environ.get("K12_TARGET_HEALTHY", "25")))
    ap.add_argument("--auth-dir", default=os.environ.get("CPA_AUTH_DIR", "/root/.cli-proxy-api"))
    ap.add_argument("--pool-dir", default=os.environ.get("K12_POOL_DIR", "/opt/cliproxy/k12-pool"))
    ap.add_argument("--state-dir", default=os.environ.get("K12_STATE_DIR", "/opt/cliproxy/k12-state"))
    ap.add_argument("--concurrency", type=int, default=int(os.environ.get("K12_PROBE_CONCURRENCY", "8")))
    ap.add_argument("--timeout", type=float, default=float(os.environ.get("K12_PROBE_TIMEOUT", "25")))
    ap.add_argument("--probe-model", default=os.environ.get("K12_PROBE_MODEL", "gpt-5.4-mini"))
    args = ap.parse_args()
    sys.exit(
        run(
            auth_dir=Path(args.auth_dir),
            pool_dir=Path(args.pool_dir),
            state_dir=Path(args.state_dir),
            target=args.target,
            check_only=args.check_only,
            concurrency=args.concurrency,
            timeout=args.timeout,
            probe_model=args.probe_model,
        )
    )


if __name__ == "__main__":
    main()

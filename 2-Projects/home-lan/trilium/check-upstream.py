#!/usr/bin/env python3
"""Track upstream and propose a maintenance PR; never deploy or merge."""
import argparse
import base64
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

REPO = "Hahaxiong838383/oh-my-ccwork"
PREFIX = "2-Projects/home-lan/trilium"
UPSTREAM = "TriliumNext/Trilium"
BRANCH_PREFIX = "maintenance/trilium-"
SOURCE = Path.home() / "home-lan/runtime/trilium-upstream"
STATE = Path.home() / ".local/state/trilium"
PROXY = "http://127.0.0.1:10808"
GIT_PROXY = "socks5h://127.0.0.1:10808"


def version(value):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", value):
        raise ValueError("not_a_stable_version")
    return tuple(map(int, value[1:].split(".")))


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def save(value):
    temporary = STATE / ".update-status.tmp"
    temporary.write_text(dump(value))
    temporary.chmod(0o600)
    temporary.replace(STATE / "update-status.json")


class Github:
    def __init__(self):
        result = subprocess.run(
            ["git", "-C", str(Path.home() / "mycc"), "credential", "fill"],
            input="protocol=https\nhost=github.com\n\n", capture_output=True,
            text=True, timeout=30, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
        values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        if result.returncode or not values.get("password"):
            raise RuntimeError("github_credential_unavailable")
        self.token = values["password"]
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"https": PROXY, "http": PROXY}))

    def call(self, path, data=None, method=None):
        request = urllib.request.Request(
            "https://api.github.com/" + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": "Bearer " + self.token,
                     "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json",
                     "X-GitHub-Api-Version": "2022-11-28"}, method=method)
        with self.opener.open(request, timeout=40) as response:
            return json.load(response)

    def file(self, name, ref="main"):
        result = self.call(f"repos/{REPO}/contents/{PREFIX}/{name}?ref=" + urllib.parse.quote(ref, safe=""))
        return base64.b64decode(result["content"]).decode()


def registry_digest(tag):
    # Public registry token: held only in memory, never used with GitHub.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY}))
    with opener.open("https://auth.docker.io/token?service=registry.docker.io&scope=repository:triliumnext/trilium:pull", timeout=30) as response:
        token = json.load(response)["token"]
    request = urllib.request.Request(
        "https://registry-1.docker.io/v2/triliumnext/trilium/manifests/" + tag,
        headers={"Authorization": "Bearer " + token,
                 "Accept": "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"})
    with opener.open(request, timeout=40) as response:
        digest = response.headers.get("Docker-Content-Digest", "")
        manifest = json.load(response)
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError("registry_digest_missing")
    if not any(x.get("platform", {}).get("architecture") == "amd64" and
               x.get("platform", {}).get("os") == "linux" for x in manifest.get("manifests", [])):
        raise RuntimeError("linux_amd64_manifest_missing")
    return digest


def check(publish=False):
    github = Github()
    metadata = github.call(f"repos/{REPO}")
    if not metadata["private"] or metadata["default_branch"] != "main":
        raise RuntimeError("unexpected_maintenance_repository")
    fetch = subprocess.run(["git", "-C", str(SOURCE), "-c", "http.proxy=" + GIT_PROXY,
                            "fetch", "--tags", "origin"], capture_output=True, text=True, timeout=120)
    if fetch.returncode:
        raise RuntimeError("upstream_fetch_failed")
    release = github.call(f"repos/{UPSTREAM}/releases/latest")
    tag = release["tag_name"]
    version(tag)
    if release["draft"] or release["prerelease"]:
        raise RuntimeError("not_a_stable_release")
    commit = github.call(f"repos/{UPSTREAM}/commits/main")["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise RuntimeError("invalid_upstream_commit")
    source_commit = subprocess.check_output(
        ["git", "-C", str(SOURCE), "rev-parse", f"{tag}^{{commit}}"], text=True, timeout=15).strip()
    desired = json.loads(github.file("desired.json"))
    tracked = json.loads(github.file("upstream.json"))
    if version(tag) < version(desired["version"]):
        raise RuntimeError("upstream_version_regressed")
    digest = registry_digest(tag)
    image = f"triliumnext/trilium:{tag}@{digest}"
    if tag == desired["version"] and (image != desired["image"] or source_commit != desired["source_commit"]):
        raise RuntimeError("stable_tag_or_image_changed_review_required")
    target = {"version": tag, "source_commit": source_commit, "image": image}
    upstream = {"repository": UPSTREAM, "main_commit": commit, "stable_version": tag,
                "stable_commit": source_commit, "release_url": release["html_url"]}
    result = {"status": "up_to_date", "upstream": upstream, "desired": target,
              "production_changed": False, "source_fetched": True,
              "check_scope": "metadata_and_linux_amd64_manifest_only"}
    if target == desired and upstream == tracked:
        return result
    compose = github.file("compose.yaml")
    if compose.count(desired["image"]) != 1:
        raise RuntimeError("compose_image_not_unique")
    changes = {"desired.json": dump(target), "upstream.json": dump(upstream),
               "compose.yaml": compose.replace(desired["image"], image)}
    comparison = f"https://github.com/{UPSTREAM}/compare/{tracked['main_commit']}...{commit}"
    release_change = tag != desired["version"]
    body = (f"跟踪 TriliumNext 上游：稳定版 `{desired['version']}` → `{tag}`。\n\n"
            f"[上游提交差异]({comparison}) · [版本说明]({release['html_url']})\n\n"
            + ("此 PR 更新候选部署镜像和摘要。" if release_change else "稳定版未变，此 PR 仅更新上游跟踪基线；生产镜像保持。")
            + "\n\n已验证：源码 fetch、稳定标签、官方镜像摘要及 Linux amd64 清单。"
            "尚未验证：候选版本网页读写、附件、导入、备份恢复和 NAS 兼容性。"
            "合并不会自动部署；实际升级前需备份，在隔离实例验收，再更新生产与 deployed.json。"
            "\n\n生产数据、凭据和私人笔记不在本 PR 中。")
    changes["UPSTREAM-REVIEW.md"] = body + "\n"
    result.update(status="update_available", release_change=release_change, compare_url=comparison)
    if not publish:
        return result
    pulls = []
    page = 1
    while True:
        batch = github.call(f"repos/{REPO}/pulls?state=open&per_page=100&page={page}")
        pulls.extend(p for p in batch if p["head"]["ref"].startswith(BRANCH_PREFIX)
                     and p["head"]["repo"] and p["head"]["repo"]["full_name"] == REPO)
        if len(batch) < 100:
            break
        page += 1
    if len(pulls) > 1:
        raise RuntimeError("duplicate_open_update_prs")
    if pulls:
        # An open PR may contain human review edits. Do not overwrite its branch.
        return {**result, "status": "pr_pending_review", "pr_url": pulls[0]["html_url"]}
    branch_name = f"{BRANCH_PREFIX}{tag}-{commit[:12]}"
    ref_path = f"repos/{REPO}/git/ref/heads/{branch_name}"
    try:
        branch = github.call(ref_path)["object"]["sha"]
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        branch = None
    if branch:
        raise RuntimeError("closed_or_unmerged_update_branch_requires_review")
    main_sha = github.call(f"repos/{REPO}/git/ref/heads/main")["object"]["sha"]
    parent = main_sha
    effective = {}
    for name, content in changes.items():
        try:
            old = github.file(name, "main")
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
            old = None
        if old != content:
            effective[name] = content
    if not effective:
        raise RuntimeError("no_reviewable_changes")
    base_tree = github.call(f"repos/{REPO}/git/commits/{parent}")["tree"]["sha"]
    tree = github.call(f"repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": [
        {"path": f"{PREFIX}/{name}", "mode": "100644", "type": "blob", "content": content}
        for name, content in effective.items()]})
    new_commit = github.call(f"repos/{REPO}/git/commits", {
        "message": f"chore(trilium): track {tag} and upstream {commit[:8]}",
        "tree": tree["sha"], "parents": [parent]})
    github.call(f"repos/{REPO}/git/refs", {"ref": "refs/heads/" + branch_name, "sha": new_commit["sha"]})
    title = f"chore(trilium): 上游跟踪 {tag}" + ("，待验收升级" if release_change else "（稳定版未变）")
    pr = github.call(f"repos/{REPO}/pulls", {
        "title": title, "body": body, "head": branch_name, "base": "main", "draft": True})
    return {**result, "status": "pr_created", "pr_url": pr["html_url"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true", help="Create an upgrade PR unless one is open; never deploy")
    args = parser.parse_args()
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / "update-check.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        start = dt.datetime.now(dt.timezone.utc).isoformat()
        save({"status": "running", "started_at": start})
        try:
            result = check(args.publish)
        except Exception as error:
            result = {"status": "error", "error_type": type(error).__name__, "production_changed": False}
            if isinstance(error, RuntimeError):
                result["reason"] = str(error)
        result.update(checked_at=dt.datetime.now(dt.timezone.utc).isoformat(), started_at=start)
        save(result)
        print(dump(result), end="")
        return int(result["status"] == "error")


if __name__ == "__main__":
    raise SystemExit(main())

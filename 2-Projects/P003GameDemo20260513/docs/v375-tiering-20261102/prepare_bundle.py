#!/usr/bin/env python3
"""Export a fixed candidate's runtime delta; does not connect to or mutate production."""
import argparse, hashlib, json, pathlib, subprocess, tarfile
BASE = "9e7aab980114b796e22cc5286a1edf5c44f3b35a"
PREFIX = "2-Projects/P003GameDemo20260513/"
parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--out", required=True)
a = parser.parse_args()
repo = pathlib.Path(a.repo).resolve()
def git(*args):
    return subprocess.check_output(["git", "-C", str(repo), *args])
sha = git("rev-parse", "--verify", a.candidate + "^{commit}").decode().strip()
subprocess.run(["git", "-C", str(repo), "merge-base", "--is-ancestor", BASE, sha], check=True)
out = pathlib.Path(a.out).resolve()
out.mkdir(parents=True, exist_ok=False)
rows = []
for path in git("diff", "--name-only", BASE, sha).decode().splitlines():
    if not (path.startswith(PREFIX + "apps/server/src/") or path == PREFIX + "apps/web/public/admin/index.html"):
        continue
    target = path.removeprefix(PREFIX)
    after = git("show", sha + ":" + path)
    exists = subprocess.run(["git", "-C", str(repo), "cat-file", "-e", BASE + ":" + path], stderr=subprocess.DEVNULL).returncode == 0
    before = git("show", BASE + ":" + path) if exists else None
    for directory, data in [("after", after), ("before", before)]:
        if data is not None:
            f = out / directory / target
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(data)
    rows.append({"repo_path": path, "relative_target": target, "before_sha256": hashlib.sha256(before).hexdigest() if before is not None else None,
                 "after_sha256": hashlib.sha256(after).hexdigest(), "rollback": "restore exact saved predeployment bytes" if exists else "remove only if current SHA equals after_sha256"})
manifest = {"candidate_sha": sha, "comparison_base_sha": BASE, "deployment_executor": "session13-only", "production_mutated": False,
            "precondition": "Every existing target must equal before_sha256; every new target must be absent. Drift requires rebase/review, never force overwrite.",
            "database": "additive tables only; keep live data and seen; never restore whole DB", "files": rows}
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
with tarfile.open(str(out) + ".tar.gz", "w:gz") as tar:
    tar.add(out, arcname=out.name)
print(json.dumps({"candidate_sha": sha, "runtime_files": len(rows), "bundle": str(out) + ".tar.gz", "sha256": hashlib.sha256(pathlib.Path(str(out) + ".tar.gz").read_bytes()).hexdigest()}, ensure_ascii=False))

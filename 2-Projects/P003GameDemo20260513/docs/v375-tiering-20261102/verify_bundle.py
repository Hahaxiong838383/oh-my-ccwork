#!/usr/bin/env python3
"""Read-only per-file deployment/rollback preflight. Any drift fails closed."""
import argparse, hashlib, json, pathlib, sys
p=argparse.ArgumentParser()
p.add_argument("--bundle",required=True)
p.add_argument("--production-root",required=True)
p.add_argument("--phase",choices=["before","after"],required=True)
a=p.parse_args()
b=pathlib.Path(a.bundle).resolve(); root=pathlib.Path(a.production_root).resolve()
m=json.loads((b/"manifest.json").read_text()); results=[]
for f in m["files"]:
    rel=f["relative_target"]
    if rel.startswith("apps/server/src/"):
        target=root/"server"/rel.removeprefix("apps/server/")
    elif rel=="apps/web/public/admin/index.html":
        target=root/"web/dist/admin/index.html"
    else:
        raise SystemExit("unrecognized target")
    if not target.resolve().is_relative_to(root) or target.is_symlink():
        raise SystemExit("unsafe target")
    current=hashlib.sha256(target.read_bytes()).hexdigest() if target.exists() else None
    expected=f[a.phase+"_sha256"]
    results.append({"path":str(target),"match":current==expected,"expected":expected,"actual":current})
print(json.dumps({"candidate_sha":m["candidate_sha"],"phase":a.phase,"files":results},ensure_ascii=False,indent=2))
sys.exit(0 if all(f["match"] for f in results) else 1)

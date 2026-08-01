import json
import os
import re
import threading
import time


TERMINAL_STATUSES = {"completed", "failed", "aborted"}
ACTIVE_STATUSES = {"queued", "running", "aborting"}
TASK_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")


def now_text():
    return time.strftime("%Y-%m-%d %H:%M:%S %Z")


class RevisionedTaskStore:
    def __init__(self, directory):
        self.directory = directory
        self.lock = threading.RLock()

    def _ensure_directory(self):
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)

    def _path(self, task_id):
        task_id = str(task_id or "").strip()
        if not TASK_ID_PATTERN.fullmatch(task_id):
            raise ValueError("invalid task id")
        return os.path.join(self.directory, task_id + ".json")

    def _save_unlocked(self, snapshot):
        self._ensure_directory()
        path = self._path(snapshot["id"])
        temp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(temp_path, "w", encoding="utf-8") as file:
            json.dump(snapshot, file, ensure_ascii=False, indent=2)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)

    def create(self, snapshot):
        with self.lock:
            task_id = str(snapshot.get("id") or "").strip()
            path = self._path(task_id)
            if os.path.exists(path):
                raise FileExistsError(task_id)
            created_at = snapshot.get("createdAt") or now_text()
            item = dict(snapshot)
            item.update({
                "id": task_id,
                "status": "queued",
                "terminal": False,
                "revision": 1,
                "createdAt": created_at,
                "updatedAt": created_at,
            })
            self._save_unlocked(item)
            return dict(item)

    def load(self, task_id):
        try:
            path = self._path(task_id)
        except ValueError:
            return None
        with self.lock:
            try:
                with open(path, encoding="utf-8") as file:
                    return json.load(file)
            except (OSError, ValueError, TypeError):
                return None

    def update(self, task_id, changes, expected_revision=None):
        with self.lock:
            current = self.load(task_id)
            if current is None:
                return {"ok": False, "error": "task_not_found"}
            if expected_revision is not None and current.get("revision") != expected_revision:
                return {"ok": False, "error": "revision_conflict", "task": current}
            if current.get("status") in TERMINAL_STATUSES and changes.get("status") not in (None, current.get("status")):
                return {"ok": False, "error": "task_terminal", "task": current}
            updated = dict(current)
            updated.update(changes)
            updated["revision"] = int(current.get("revision") or 0) + 1
            updated["updatedAt"] = now_text()
            updated["terminal"] = updated.get("status") in TERMINAL_STATUSES
            self._save_unlocked(updated)
            return {"ok": True, "task": dict(updated)}

    def list(self, limit=50):
        self._ensure_directory()
        items = []
        with self.lock:
            for name in os.listdir(self.directory):
                if not name.endswith(".json"):
                    continue
                item = self.load(name[:-5])
                if item:
                    items.append(item)
        return sorted(items, key=lambda item: item.get("createdAt", ""), reverse=True)[:limit]

    def find_by_client_request_id(self, client_request_id, limit=200):
        client_request_id = str(client_request_id or "").strip()
        if not client_request_id:
            return None
        for item in self.list(limit):
            if item.get("clientRequestId") == client_request_id:
                return item
        return None

    def active(self):
        return [item for item in self.list(200) if item.get("status") in ACTIVE_STATUSES]

    def reconcile_interrupted(self):
        reconciled = []
        for item in self.active():
            result = self.update(item["id"], {
                "ok": False,
                "status": "failed",
                "error": "inspector_restarted",
                "answer": "任务因 AI Ops Inspector 重启而中断，请重新发送。",
                "finishedAt": now_text(),
            })
            if result.get("ok"):
                reconciled.append(result["task"])
        return reconciled

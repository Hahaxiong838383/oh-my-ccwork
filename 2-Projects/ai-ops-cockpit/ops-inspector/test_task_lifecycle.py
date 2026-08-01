import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from task_lifecycle import RevisionedTaskStore


class RevisionedTaskStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = RevisionedTaskStore(os.path.join(self.temp.name, "tasks"))

    def tearDown(self):
        self.temp.cleanup()

    def test_revision_only_moves_forward(self):
        created = self.store.create({"id": "task-1", "question": "inspect"})
        self.assertEqual(created["revision"], 1)
        running = self.store.update("task-1", {"status": "running"}, expected_revision=1)
        self.assertTrue(running["ok"])
        self.assertEqual(running["task"]["revision"], 2)
        conflict = self.store.update("task-1", {"status": "aborting"}, expected_revision=1)
        self.assertEqual(conflict["error"], "revision_conflict")
        self.assertEqual(conflict["task"]["revision"], 2)

    def test_client_request_id_is_idempotent(self):
        self.store.create({"id": "task-2", "clientRequestId": "browser-1"})
        found = self.store.find_by_client_request_id("browser-1")
        self.assertEqual(found["id"], "task-2")

    def test_terminal_task_cannot_return_to_running(self):
        self.store.create({"id": "task-3"})
        completed = self.store.update("task-3", {"status": "completed", "ok": True})
        self.assertTrue(completed["task"]["terminal"])
        invalid = self.store.update("task-3", {"status": "running"})
        self.assertEqual(invalid["error"], "task_terminal")

    def test_reconcile_marks_interrupted_tasks_failed(self):
        self.store.create({"id": "task-4"})
        self.store.update("task-4", {"status": "running"})
        reconciled = self.store.reconcile_interrupted()
        self.assertEqual(len(reconciled), 1)
        snapshot = self.store.load("task-4")
        self.assertEqual(snapshot["status"], "failed")
        self.assertEqual(snapshot["error"], "inspector_restarted")

    def test_snapshot_files_are_private(self):
        self.store.create({"id": "task-5"})
        path = os.path.join(self.temp.name, "tasks", "task-5.json")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

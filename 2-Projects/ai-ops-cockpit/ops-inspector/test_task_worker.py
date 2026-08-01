import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))

import server
from task_lifecycle import RevisionedTaskStore


class TaskWorkerTest(unittest.TestCase):
    def test_terminal_task_never_restarts_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RevisionedTaskStore(directory)
            store.create({"id": "terminal-task"})
            store.update("terminal-task", {"status": "aborted", "ok": False})
            with mock.patch.object(server, "TASK_STORE", store), mock.patch.object(server, "execute_vibe_task") as execute:
                server.run_vibe_task_worker("terminal-task", {}, False)
            execute.assert_not_called()
            self.assertEqual(store.load("terminal-task")["status"], "aborted")


if __name__ == "__main__":
    unittest.main()

import importlib.util
import os
import subprocess
import tempfile
import unittest
from unittest import mock


MODULE_PATH = os.path.join(os.path.dirname(__file__), "brain-server.py")
SPEC = importlib.util.spec_from_file_location("aiops_brain_server", MODULE_PATH)
brain = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(brain)


class FakeProcess:
    def __init__(self, stdout="", stderr="", returncode=0, pid=4321, timeout=False):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.pid = pid
        self.timeout = timeout

    def communicate(self, timeout=None):
        if self.timeout:
            raise subprocess.TimeoutExpired(["omp"], timeout)
        return self.stdout, self.stderr

    def poll(self):
        return self.returncode


class BrainServerTests(unittest.TestCase):
    def test_command_loads_only_explicit_policy_extension(self):
        command = brain.build_omp_command("/tmp/prompt.md")
        self.assertIn("--extension", command)
        self.assertIn(brain.EXTENSION, command)
        self.assertNotIn("--no-extensions", command)
        self.assertNotIn("--tools", command)
        self.assertIn("--no-tools", command)
        self.assertIn("--no-rules", command)
        self.assertIn("--no-skills", command)
        self.assertNotIn("--no-prewalk", command)
        self.assertIn("--no-title", command)

    def test_model_config_uses_isolated_agent_dir(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "models.yml")
            agent_dir = os.path.join(temp, "brain-agent")
            with open(source, "w", encoding="utf-8") as file:
                file.write("providers: {}\n")
            with mock.patch.object(brain, "AGENT_DIR", agent_dir), mock.patch.object(brain, "MODEL_CONFIG_SOURCE", source):
                brain.ensure_model_config()
            target = os.path.join(agent_dir, "models.yml")
            self.assertTrue(os.path.isfile(target))
            self.assertEqual(os.stat(agent_dir).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)

    def test_workdir_is_private_and_owned_by_runtime_user(self):
        with tempfile.TemporaryDirectory() as temp:
            workdir = os.path.join(temp, "brain", "session")
            with mock.patch.object(brain, "WORKDIR", workdir):
                brain.ensure_workdir()
            self.assertTrue(os.path.isdir(workdir))
            self.assertEqual(os.stat(workdir).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(workdir).st_uid, os.geteuid())
            self.assertEqual(os.stat(workdir).st_gid, os.getegid())

    def test_ambient_extension_detection_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            agent_dir = os.path.join(temp, "brain-agent")
            workdir = os.path.join(temp, "work")
            os.makedirs(os.path.join(agent_dir, "extensions"))
            os.makedirs(workdir)
            with mock.patch.object(brain, "AGENT_DIR", agent_dir), mock.patch.object(brain, "WORKDIR", workdir):
                self.assertEqual(brain.ambient_extension_count(), 0)
                with open(os.path.join(agent_dir, "extensions", "unexpected.ts"), "w", encoding="utf-8") as file:
                    file.write("export default () => {}\n")
                self.assertEqual(brain.ambient_extension_count(), 1)

    def test_internal_token_is_redacted(self):
        with mock.patch.object(brain, "INTERNAL_TOKEN", "internal-token-value-123"):
            self.assertNotIn("internal-token-value-123", brain.sanitize_output("x=internal-token-value-123"))

    def test_run_task_binds_project_and_task_to_subprocess_environment(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "models.yml")
            workdir = os.path.join(temp, "brain", "session")
            agent_dir = os.path.join(temp, "agent")
            with open(source, "w", encoding="utf-8") as file:
                file.write("providers: {}\n")
            process = FakeProcess(stdout="TASK_OK\n", returncode=0)
            with (
                mock.patch.object(brain, "WORKDIR", workdir),
                mock.patch.object(brain, "AGENT_DIR", agent_dir),
                mock.patch.object(brain, "MODEL_CONFIG_SOURCE", source),
                mock.patch.object(brain.subprocess, "Popen", return_value=process) as popen,
            ):
                result = brain.run_task({"taskId": "unit-task", "project": "chenchuan-site", "workflow": "readonly_safe", "prompt": "inspect"})
            self.assertTrue(result["ok"])
            self.assertEqual(result["output"], "TASK_OK\n")
            self.assertEqual(popen.call_args.kwargs["cwd"], workdir)
            self.assertEqual(popen.call_args.kwargs["env"]["AI_OPS_BRAIN_TASK_ID"], "unit-task")
            self.assertEqual(popen.call_args.kwargs["env"]["AI_OPS_BRAIN_PROJECT"], "chenchuan-site")

    def test_run_task_timeout_is_structured_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            source = os.path.join(temp, "models.yml")
            workdir = os.path.join(temp, "brain", "session")
            agent_dir = os.path.join(temp, "agent")
            with open(source, "w", encoding="utf-8") as file:
                file.write("providers: {}\n")
            with (
                mock.patch.object(brain, "WORKDIR", workdir),
                mock.patch.object(brain, "AGENT_DIR", agent_dir),
                mock.patch.object(brain, "MODEL_CONFIG_SOURCE", source),
                mock.patch.object(brain.subprocess, "Popen", return_value=FakeProcess(returncode=None, timeout=True)),
                mock.patch.object(brain, "_signal_process", return_value=True),
            ):
                result = brain.run_task({"taskId": "unit-timeout", "project": "chenchuan-site", "workflow": "readonly_safe", "prompt": "inspect"})
            self.assertEqual(result["error"], "brain_timeout")
            self.assertTrue(brain.TASK_LOCK.acquire(blocking=False))
            brain.TASK_LOCK.release()

    def test_abort_only_signals_matching_active_task(self):
        process = FakeProcess(returncode=None)
        with brain.PROCESS_LOCK:
            brain.ACTIVE_PROCESS.update({"taskId": "unit-abort", "process": process, "abortRequested": False})
        with mock.patch.object(brain, "_signal_process", return_value=True) as signal_process:
            result = brain.abort_task({"taskId": "unit-abort"})
        self.assertTrue(result["ok"])
        self.assertTrue(brain.ACTIVE_PROCESS["abortRequested"])
        signal_process.assert_called_once_with(process, brain.signal.SIGTERM)
        with brain.PROCESS_LOCK:
            brain.ACTIVE_PROCESS.update({"taskId": None, "process": None, "abortRequested": False})

    def test_abort_rejects_other_task(self):
        process = FakeProcess(returncode=None)
        with brain.PROCESS_LOCK:
            brain.ACTIVE_PROCESS.update({"taskId": "active-task", "process": process, "abortRequested": False})
        result = brain.abort_task({"taskId": "other-task"})
        self.assertEqual(result["error"], "task_not_running")
        with brain.PROCESS_LOCK:
            brain.ACTIVE_PROCESS.update({"taskId": None, "process": None, "abortRequested": False})

    def test_abort_before_process_start_is_consumed(self):
        with brain.PROCESS_LOCK:
            brain.ACTIVE_PROCESS.update({"taskId": None, "process": None, "abortRequested": False})
            brain.PENDING_ABORTS.clear()
        result = brain.abort_task({"taskId": "pending-task"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "abort_pending")
        self.assertTrue(brain._consume_pending_abort("pending-task"))
        self.assertFalse(brain._consume_pending_abort("pending-task"))


if __name__ == "__main__":
    unittest.main()

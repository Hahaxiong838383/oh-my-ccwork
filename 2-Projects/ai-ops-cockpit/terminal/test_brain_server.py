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
            completed = subprocess.CompletedProcess(["omp"], 0, stdout="TASK_OK\n", stderr="")
            with (
                mock.patch.object(brain, "WORKDIR", workdir),
                mock.patch.object(brain, "AGENT_DIR", agent_dir),
                mock.patch.object(brain, "MODEL_CONFIG_SOURCE", source),
                mock.patch.object(brain.subprocess, "run", return_value=completed) as run,
            ):
                result = brain.run_task({"taskId": "unit-task", "project": "chenchuan-site", "workflow": "readonly_safe", "prompt": "inspect"})
            self.assertTrue(result["ok"])
            self.assertEqual(result["output"], "TASK_OK\n")
            self.assertEqual(run.call_args.kwargs["cwd"], workdir)
            self.assertEqual(run.call_args.kwargs["env"]["AI_OPS_BRAIN_TASK_ID"], "unit-task")
            self.assertEqual(run.call_args.kwargs["env"]["AI_OPS_BRAIN_PROJECT"], "chenchuan-site")

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
                mock.patch.object(brain.subprocess, "run", side_effect=subprocess.TimeoutExpired(["omp"], 190)),
            ):
                result = brain.run_task({"taskId": "unit-timeout", "project": "chenchuan-site", "workflow": "readonly_safe", "prompt": "inspect"})
            self.assertEqual(result["error"], "brain_timeout")
            self.assertTrue(brain.TASK_LOCK.acquire(blocking=False))
            brain.TASK_LOCK.release()


if __name__ == "__main__":
    unittest.main()

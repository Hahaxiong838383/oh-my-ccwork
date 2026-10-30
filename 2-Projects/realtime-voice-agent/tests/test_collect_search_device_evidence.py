import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import subprocess

MODULE = Path(__file__).resolve().parents[1] / "tools/collect_search_device_evidence.py"
spec = importlib.util.spec_from_file_location("collect_search_device_evidence", MODULE)
diag = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diag)
SN = "BJP00326060100100004"


class DeviceEvidenceTest(unittest.TestCase):
    def fake_adb(self, *, sn=SN, change_apk=False):
        self.commands = []
        self.sha_reads = 0

        def run(argv, **kwargs):
            self.assertEqual(argv[:3], ["adb", "-s", "usb-current"])
            self.commands.append(argv[3:])
            command = argv[3:]
            if command == ["get-state"]:
                value = "device\n"
            elif command == ["shell", "settings get global p003_mcu_device_sn"]:
                value = sn + "\n"
            elif command == ["shell", "pm path " + diag.PACKAGE]:
                value = "package:/data/app/active/base.apk\n"
            elif command == ["shell", "sha256sum /data/app/active/base.apk"]:
                self.sha_reads += 1
                value = ("b" if change_apk and self.sha_reads > 1 else "a") * 64 + "  /data/app/active/base.apk\n"
            elif command == ["shell", "dumpsys package " + diag.PACKAGE]:
                value = " versionCode=367 minSdk=26\n versionName=1.2.2-canary.353\n"
            else:
                value = "PRIVATE_DIAGNOSTIC_BODY\n"
            return subprocess.CompletedProcess(argv, 0, stdout=value.encode(), stderr=b"")
        return run

    def test_wrong_mcu_identity_stops_before_logs_or_apk_reads(self):
        with tempfile.TemporaryDirectory() as d, patch.object(diag.subprocess, "run", self.fake_adb(sn="BJP00326070803800006")):
            out = Path(d) / "new"
            with self.assertRaisesRegex(diag.CollectionError, "MCU SN"):
                diag.Collector("adb", "usb-current", SN, out, "run-1").run()
            self.assertFalse(out.exists())
            self.assertEqual(len(self.commands), 2)

    def test_capture_is_private_read_only_and_uses_active_apk(self):
        with tempfile.TemporaryDirectory() as d, patch.object(diag.subprocess, "run", self.fake_adb()):
            out = Path(d) / "new"
            result = diag.Collector("adb", "usb-current", SN, out, "run-1").run()
            self.assertEqual(result["status"], "collected")
            self.assertEqual(result["apk"]["version_code"], 367)
            self.assertEqual(result["apk"]["sha256"], "a" * 64)
            self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o700)
            for path in out.iterdir():
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            manifest = (out / "manifest-private.json").read_text()
            self.assertNotIn("PRIVATE_DIAGNOSTIC_BODY", manifest)
            self.assertNotIn(SN, manifest)
            self.assertNotIn("usb-current", manifest)
            for command in self.commands:
                self.assertFalse(any(x in " ".join(command) for x in
                                     ["settings put", "logcat -c", " install", " reboot", " set-volume", " connect "]))

    def test_ota_during_collection_preserves_evidence_but_does_not_pass(self):
        with tempfile.TemporaryDirectory() as d, patch.object(diag.subprocess, "run", self.fake_adb(change_apk=True)):
            out = Path(d) / "new"
            with self.assertRaisesRegex(diag.CollectionError, "changed during capture"):
                diag.Collector("adb", "usb-current", SN, out, "run-1").run()
            result = json.loads((out / "manifest-private.json").read_text())
            self.assertEqual(result["status"], "partial_capture_failed")
            self.assertNotEqual(result["apk"]["sha256"], result["apk_after"]["sha256"])

    def test_existing_directory_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as d, patch.object(diag.subprocess, "run", self.fake_adb()):
            out = Path(d) / "existing"
            out.mkdir()
            sentinel = out / "manifest-private.json"
            sentinel.write_text("original-failure")
            with self.assertRaises(FileExistsError):
                diag.Collector("adb", "usb-current", SN, out, "run-1").run()
            self.assertEqual(sentinel.read_text(), "original-failure")


if __name__ == "__main__":
    unittest.main()

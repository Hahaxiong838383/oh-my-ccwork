"""Finish a disposable RTC probe after explicit assertions and cleanup.

LiveKit's native runtime can abort during Python finalization even after all
AudioSource objects have closed (upstream python-sdks#833; reproduced on 1.1.9).
This is ONLY a process-entry helper for single-use probes, never a service or a
replacement for room/stream/source cleanup. The caller must assert the actual
scenario and return counts only after awaited cleanup. An external controller
must still check the process exit, receipt, task evidence and room removal.
"""
import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import NoReturn


@dataclass(frozen=True)
class ProbeCompletion:
    rooms_created: int
    rooms_disconnected: int
    streams_created: int
    streams_closed: int
    sources_created: int
    sources_closed: int

    def validate(self) -> None:
        if any(type(value) is not int or value < 0 for value in asdict(self).values()):
            raise ValueError("invalid cleanup count")
        if (self.rooms_created != self.rooms_disconnected
                or self.streams_created != self.streams_closed
                or self.sources_created != self.sources_closed):
            raise ValueError("incomplete cleanup")


def run_disposable_probe(
    main: Callable[[], Awaitable[ProbeCompletion]], receipt_path: Path,
) -> NoReturn:
    if os.environ.get("P003_DISPOSABLE_RTC_PROBE") != "1":
        raise RuntimeError("disposable probe scope required")
    # Reserve a unique attempt before any RTC work. Old successes cannot be
    # overwritten or reused. A missing/partial receipt is never a pass.
    fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    status = 1
    evidence: dict = {"checks_passed": False, "python_finalization_bypassed": True}
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            try:
                proof = asyncio.run(main())
                if not isinstance(proof, ProbeCompletion):
                    raise TypeError("cleanup proof required")
                proof.validate()
                evidence.update(checks_passed=True, cleanup=asdict(proof))
                status = 0
            except BaseException as error:
                # Do not log exceptions containing transcripts or credentials.
                evidence["error_type"] = type(error).__name__
                status = 130 if isinstance(error, KeyboardInterrupt) else 1
            evidence.update(at_ms=int(time.time() * 1000), exit_status=status)
            json.dump(evidence, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        sys.stdout.flush()
        sys.stderr.flush()
    except BaseException:
        status = 1  # Failed evidence persistence/flush is a failed probe.
    # All application cleanup has already run. Terminating this disposable
    # process avoids only the unsafe interpreter/native runtime finalization.
    # It does not turn a failed assertion or incomplete cleanup into success.
    os._exit(status)

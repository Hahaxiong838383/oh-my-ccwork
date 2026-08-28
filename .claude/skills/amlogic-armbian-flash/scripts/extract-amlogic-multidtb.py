#!/usr/bin/env python3
"""Extract DTBs from an Amlogic AML_ version-2 multi-DTB container."""

from __future__ import annotations

import argparse
import re
import struct
from pathlib import Path

FDT_MAGIC = bytes.fromhex("d00dfeed")
ENTRY_SIZE = 56
HEADER_SIZE = 12


def decode_id(raw: bytes) -> str:
    if len(raw) != 16:
        raise ValueError("multi-DTB ID field must be 16 bytes")
    decoded = b"".join(raw[i : i + 4][::-1] for i in range(0, 16, 4))
    return decoded.decode("ascii", "replace").strip(" \0")


def safe_name(parts: list[str]) -> str:
    value = "_".join(parts)
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-") or "unknown"


def extract(source: Path, output_dir: Path) -> list[Path]:
    data = source.read_bytes()
    if len(data) < HEADER_SIZE or data[:4] != b"AML_":
        raise ValueError("input is not an Amlogic AML_ multi-DTB container")

    version, count = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ValueError(f"unsupported AML_ version: {version}")
    table_end = HEADER_SIZE + count * ENTRY_SIZE
    if table_end > len(data):
        raise ValueError("entry table exceeds input size")

    output_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for index in range(count):
        pos = HEADER_SIZE + index * ENTRY_SIZE
        ids = [decode_id(data[pos + i * 16 : pos + (i + 1) * 16]) for i in range(3)]
        offset, size = struct.unpack_from("<II", data, pos + 48)
        end = offset + size
        if offset < table_end or size <= 0 or end > len(data):
            raise ValueError(f"entry {index} has invalid range: offset={offset:#x}, size={size:#x}")
        blob = data[offset:end]
        if blob[:4] != FDT_MAGIC:
            raise ValueError(f"entry {index} does not start with FDT magic")
        target = output_dir / f"{safe_name(ids)}.dtb"
        target.write_bytes(blob)
        written.append(target)
        print(f"{index}: {'/'.join(ids)} offset={offset:#x} size={size:#x} -> {target}")
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="decompressed AML_ multi-DTB container")
    parser.add_argument("output_dir", type=Path, help="directory for extracted .dtb files")
    args = parser.parse_args()
    extract(args.input, args.output_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Read-only structural inspection for SVG/XML- or PDF-backed AI artwork."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape"
SODIPODI_NS = "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
SVG_NS = "http://www.w3.org/2000/svg"


def run(command: list[str]) -> tuple[int, str, str]:
    process = subprocess.run(command, text=True, capture_output=True)
    return process.returncode, process.stdout, process.stderr


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_key_values(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            result[key.strip()] = value.strip()
    return result


def tag_name(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def inspect_svg(path: Path) -> dict[str, Any]:
    tree = ET.parse(path)
    root = tree.getroot()
    elements = list(root.iter())
    counts: dict[str, int] = {}
    for element in elements:
        name = tag_name(element)
        counts[name] = counts.get(name, 0) + 1

    layers = []
    live_text = []
    hidden = []
    locked = []
    images = []
    for element in elements:
        element_id = element.get("id")
        label = element.get(f"{{{INKSCAPE_NS}}}label")
        if element.get(f"{{{INKSCAPE_NS}}}groupmode") == "layer":
            layers.append({"id": element_id, "label": label})
        if tag_name(element) in {"text", "flowRoot"}:
            text = "".join(element.itertext()).strip()
            live_text.append({"id": element_id, "text": text})
        style = element.get("style", "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style or element.get("display") == "none":
            hidden.append(element_id or tag_name(element))
        if element.get(f"{{{SODIPODI_NS}}}insensitive") == "true":
            locked.append(element_id or tag_name(element))
        if tag_name(element) == "image":
            href = element.get("href") or element.get("{http://www.w3.org/1999/xlink}href")
            images.append({"id": element_id, "href": href})

    named_view = next((e for e in elements if tag_name(e) == "namedview"), None)
    pages = []
    if named_view is not None:
        for page in named_view:
            if tag_name(page) == "page":
                pages.append({
                    "id": page.get("id"),
                    "x": page.get("x"),
                    "y": page.get("y"),
                    "width": page.get("width"),
                    "height": page.get("height"),
                })

    return {
        "root_tag": tag_name(root),
        "width": root.get("width"),
        "height": root.get("height"),
        "viewBox": root.get("viewBox"),
        "element_counts": counts,
        "layers": layers,
        "pages": pages,
        "live_text": live_text,
        "images": images,
        "hidden_objects": hidden,
        "locked_objects": locked,
    }


def inspect_pdf(path: Path) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for tool, key in (("pdfinfo", "pdfinfo"), ("pdffonts", "fonts"), ("pdfimages", "images")):
        executable = shutil.which(tool)
        if not executable:
            data[key] = {"available": False}
            continue
        command = [executable, str(path)] if tool != "pdfimages" else [executable, "-list", str(path)]
        code, out, err = run(command)
        if tool == "pdfinfo" and code == 0:
            data[key] = parse_key_values(out)
        else:
            data[key] = {"exit_code": code, "output": out.strip(), "error": err.strip()}
    return data


def inkscape_query(path: Path, real_format: str) -> dict[str, Any]:
    executable = shutil.which("inkscape") or ("/opt/homebrew/bin/inkscape" if Path("/opt/homebrew/bin/inkscape").exists() else None)
    if not executable:
        return {"available": False}
    suffix = ".svg" if real_format == "svg" else ".pdf"
    with tempfile.TemporaryDirectory(prefix="vector-inspect-") as temp_dir:
        normalized = Path(temp_dir) / f"source{suffix}"
        shutil.copy2(path, normalized)
        code, out, err = run([executable, str(normalized), "--query-all"])
    rows = []
    if code == 0:
        for row in csv.reader(out.splitlines()):
            if len(row) >= 5:
                try:
                    rows.append({
                        "id": row[0],
                        "x": float(row[1]),
                        "y": float(row[2]),
                        "width": float(row[3]),
                        "height": float(row[4]),
                    })
                except ValueError:
                    pass
    return {
        "available": True,
        "exit_code": code,
        "object_count": len(rows),
        "objects": rows,
        "error": err.strip(),
    }


def classify(file_description: str, path: Path) -> str:
    prefix = path.read_bytes()[:16].lstrip()
    if prefix.startswith(b"%PDF") or "PDF document" in file_description:
        return "pdf"
    if prefix.startswith(b"<") or "SVG" in file_description or "XML" in file_description:
        return "svg"
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artwork", type=Path)
    parser.add_argument("--json", action="store_true", help="print JSON only")
    parser.add_argument("--include-objects", action="store_true", help="include every Inkscape object bound")
    args = parser.parse_args()

    path = args.artwork.expanduser().resolve()
    if not path.is_file():
        parser.error(f"not a file: {path}")

    file_tool = shutil.which("file") or "/usr/bin/file"
    code, out, err = run([file_tool, "-b", str(path)])
    description = out.strip() if code == 0 else err.strip()
    real_format = classify(description, path)
    report: dict[str, Any] = {
        "path": str(path),
        "filename_extension": path.suffix.lower(),
        "file_description": description,
        "real_format": real_format,
        "sha256": sha256(path),
        "size_bytes": path.stat().st_size,
    }

    try:
        if real_format == "svg":
            report["structure"] = inspect_svg(path)
        elif real_format == "pdf":
            report["structure"] = inspect_pdf(path)
        else:
            report["warning"] = "Unsupported or unrecognized vector format"
    except Exception as exc:
        report["structure_error"] = f"{type(exc).__name__}: {exc}"

    if real_format in {"svg", "pdf"}:
        query = inkscape_query(path, real_format)
        if not args.include_objects:
            query.pop("objects", None)
        report["inkscape_query"] = query

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Path: {report['path']}")
        print(f"SHA-256: {report['sha256']}")
        print(f"Extension: {report['filename_extension'] or '(none)'}")
        print(f"Detected: {report['file_description']}")
        print(f"Real format: {report['real_format']}")
        structure = report.get("structure", {})
        if real_format == "svg":
            print(f"Canvas: {structure.get('width')} × {structure.get('height')} viewBox={structure.get('viewBox')}")
            print(f"Layers: {json.dumps(structure.get('layers', []), ensure_ascii=False)}")
            print(f"Element counts: {json.dumps(structure.get('element_counts', {}), ensure_ascii=False, sort_keys=True)}")
            print(f"Live text: {json.dumps(structure.get('live_text', []), ensure_ascii=False)}")
            print(f"Images: {len(structure.get('images', []))}; hidden: {len(structure.get('hidden_objects', []))}; locked: {len(structure.get('locked_objects', []))}")
        elif real_format == "pdf":
            info = structure.get("pdfinfo", {})
            print(f"Pages: {info.get('Pages', '?')}; page size: {info.get('Page size', '?')}")
            print(f"Creator: {info.get('Creator', '?')}; producer: {info.get('Producer', '?')}")
            fonts = structure.get("fonts", {})
            print("Fonts table present:", bool(fonts.get("output")))
            images = structure.get("images", {})
            print("Images table present:", bool(images.get("output")))
        query = report.get("inkscape_query", {})
        print(f"Inkscape query: exit={query.get('exit_code', 'n/a')} objects={query.get('object_count', 'n/a')}")
        if query.get("error"):
            print(f"Inkscape warning: {query['error']}", file=sys.stderr)
    return 0 if real_format in {"svg", "pdf"} else 2


if __name__ == "__main__":
    raise SystemExit(main())

---
name: vector-artwork-editing
description: Inspect, edit, and validate Illustrator-compatible AI, SVG, and PDF vector artwork, especially laser engraving, etching, CMF, packaging, nameplate, and manufacturing drawings. Use when a file has an .ai extension but may contain SVG/XML or PDF data; when outlined text must be replaced while preserving font, size, weight, stroke, tracking, baseline, spacing, and visual centering; when editable AI/PDF/SVG deliverables and localized pixel-diff proof are required; or when Codex must audit artboards/pages, layers/groups, live text, paths, images, clipping, locks, and editability before modifying artwork.
---

# Vector Artwork Editing

Treat vector production files as manufacturing assets. Inspect first, edit a copy, preserve geometry, and prove that changes are localized.

## Required workflow

1. **Preserve the source.** Record its path and SHA-256. Work in a separate task directory. Never overwrite the original unless the user explicitly requests it.
2. **Identify the real format.** Do not trust `.ai`. Run `file`, then inspect SVG/XML or PDF structure accordingly.
3. **Audit editability.** Report pages/artboards, layers/groups, paths, live text, images, clips/masks, hidden/locked objects, fonts, and whether the target text is live or outlined.
4. **Render a baseline.** Use one stable renderer and DPI for both baseline and candidate. Keep the baseline before editing.
5. **Locate the target geometry.** Use text extraction only as a hint. For outlined text, combine object bounds, group/order analysis, enlarged crops, OCR, and glyph geometry.
6. **Recover typography and layout.** Determine font face, size, weight, fill, stroke, baseline, tracking, segment gaps, and the original visual center. Match several known glyphs rather than one glyph.
7. **Generate vector glyphs.** Prefer preserving unchanged outlines. Generate only new glyphs from the matched font with `fontTools` and convert them to paths. Do not leave new live text in an outlined production design.
8. **Rebuild and recenter.** Preserve original tracking and explicit inter-segment gaps. For longer wording, center the complete visual row on the original row or engraving-area center, not merely the text origin.
9. **Validate at several layers.** Check parse validity, object bounds, OCR, 300-DPI rendering, pixel diff, and unchanged non-target geometry.
10. **Deliver truthfully.** Match the source's real format. If a PDF-backed `.ai` is required downstream, provide identical PDF content under `.ai` and `.pdf` names and state that fact. Include full and detail previews.

## Start with the bundled tools

```bash
SKILL_DIR=/Users/rayman.chen/mycc/.claude/skills/vector-artwork-editing

python3 "$SKILL_DIR/scripts/inspect_artwork.py" "/absolute/path/drawing.ai"
"$SKILL_DIR/scripts/render_artwork.sh" "/absolute/path/drawing.ai" /tmp/baseline.png 300
swift "$SKILL_DIR/scripts/ocr_macos.swift" /tmp/enlarged-crop.png
swift "$SKILL_DIR/scripts/pixel_diff.swift" /tmp/baseline.png /tmp/candidate.png \
  --output /tmp/diff.png --threshold 0 --expected 100,200,800,180
```

Use explicit `.svg` or `.pdf` working copies after format detection. Passing SVG content directly under an `.ai` name can make importers select the wrong parser.

## Editing rules

- Keep non-target paths byte-for-byte or structurally unchanged whenever possible.
- Preserve original transforms and object order unless the change requires regrouping.
- Measure visual bounds including strokes. A path center without stroke can differ from the rendered center.
- Recover tracking from repeated glyph origins or bounds; do not rely on a guessed CSS/text setting.
- Match a font using multiple glyphs and local font files. A single glyph can vary across font versions.
- Treat full-sheet OCR failure as expected when engraving text is tiny. Crop the row and enlarge it 6–8× before OCR.
- Keep the same render pipeline for before/after diffing. Renderer changes can create false differences everywhere.
- Require the detected pixel-diff bounding box to remain inside the authorized edit region.
- Compare object IDs/bounds outside the target group when the document structure permits it.

## Format-specific handling

### SVG/XML-backed `.ai`

- Copy to `.svg` before Inkscape operations.
- Parse namespaces, layers, groups, paths, text, images, clips, masks, and lock/visibility attributes.
- Use Inkscape `--query-all` for rendered bounds.
- Export PDF/PNG from the explicit `.svg` copy.

### PDF-backed `.ai`

- Copy to `.pdf` before PDF or Inkscape operations.
- Use `pdfinfo`, `pdffonts`, and `pdfimages -list`.
- Import to SVG only for editing, then export back to PDF.
- Expect outlined lettering to be paths even when OCR can read it.
- If the required `.ai` delivery is PDF-compatible content, copy the final PDF bytes to both extensions and document the real format.

## Acceptance checklist

- Original SHA-256 unchanged.
- Real format and editability documented.
- Target wording exactly correct.
- Font face, approximate point size, weight, fill/stroke, and tracking recorded.
- New glyphs converted to paths.
- Baseline and complete-row center differences measured.
- Full and detail OCR confirm the intended wording where OCR is reliable.
- 300-DPI diff is confined to the authorized region.
- Non-target object bounds/paths remain unchanged.
- Final vector parses and renders.
- AI/PDF/SVG deliverables and review previews are clearly named.

Read [references/methodology.md](references/methodology.md) for measurement details, failure modes, and the validated P003 examples.

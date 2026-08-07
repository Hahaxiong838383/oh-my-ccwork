# Vector artwork editing methodology

## 1. Evidence before edits

Capture:

- absolute source path;
- SHA-256;
- real file type from magic bytes;
- page/artboard dimensions;
- document creator/producer;
- layer/group/object counts;
- live text and extracted text;
- embedded or linked images;
- clip paths, masks, hidden objects, and locked objects;
- a stable baseline render.

A file extension is workflow metadata, not proof of its internal format. In the validated P003 work, one `.ai` was SVG/XML while another `.ai` was PDF 1.5.

## 2. Locating outlined text

Outlined text cannot be found reliably with ordinary text extraction. Use several signals:

1. Render the whole drawing.
2. Identify the approximate engraving region.
3. Query every object's rendered bounds.
4. Cluster small adjacent paths into rows.
5. Inspect group membership and object order.
6. Crop and enlarge the suspected row 6–8×.
7. Run OCR on the enlarged crop.
8. Compare known outline glyphs against local font candidates.

Do not infer a font from one character. Compare several distinctive glyphs, their proportions, advance widths, terminals, and counters.

## 3. Recovering typography

For each row, record:

- font file and face;
- scale or point-size estimate;
- baseline;
- fill and opacity;
- stroke color, width, joins, caps, and miter limit;
- glyph origins or visual bounds;
- repeated tracking step;
- special gaps between phrases or model-name segments;
- complete-row visual bounds and center.

For a font with units-per-em `U`, a font-unit path scaled by `s` has an em size of `U*s` in document units. Convert document units to points using the document scale. Validate the estimate against several original glyph heights and advances.

When strokes are present, use rendered bounds for final centering. Geometry-only bounds can miss half the stroke on each side.

## 4. Generating replacement outlines

Use `fontTools.ttLib.TTFont`, `getGlyphSet()`, and `SVGPathPen` to obtain path commands. Apply the recovered scale and baseline transform. Copy the original style exactly.

Prefer this order:

1. retain every unchanged original path;
2. move retained paths only when the new wording changes their position;
3. generate paths only for newly introduced glyphs;
4. assign stable IDs and optional `aria-label`/`data-*` provenance;
5. group the completed row so its rendered bounds can be queried;
6. translate the group to restore the original visual center.

Install Python dependencies into a task-local directory rather than changing the system environment:

```bash
python3 -m pip install --target "$WORK/python-libs" fonttools lxml
```

Then prepend that directory to `sys.path` in the task script.

## 5. Centering and spacing

Do not center from the first glyph origin. Compute:

```text
original_center = (original_visual_left + original_visual_right) / 2
candidate_center = (candidate_visual_left + candidate_visual_right) / 2
translation_x = original_center - candidate_center
```

For a longer replacement, preserve the measured standard tracking and any intentional phrase/model gap, then translate the complete row by `translation_x`.

Report center error in both document pixels and millimeters when the document scale is known.

## 6. Validation stack

No single check is sufficient.

### Structural

- XML parser or `xmllint` for SVG.
- `pdfinfo` for PDF.
- Inkscape query for object bounds.
- Expected path/group counts and stable IDs.
- Non-target paths/transforms unchanged.

### Semantic

- OCR the full mark and a magnified detail crop.
- Verify exact requested wording manually when OCR confidence is poor.
- Ensure no stale model name remains in metadata or reference copies.

### Visual

- Render baseline and candidate with the same engine, DPI, page, background, and crop.
- Compute changed-pixel count and bounding box.
- Require the bounding box to fit inside the authorized region.
- Inspect the heatmap/diff image.

### Production

- Open or import the final vector in the expected downstream application when UI access is available.
- Export final PDF and preview PNG again from the delivered vector.
- Keep the original source unchanged and retain hashes.

## 7. Validated P003 examples

### Expanded-screen rear shell

- Source extension: `.ai`; real format: Inkscape SVG/XML.
- Replacement: `空间光学护眼屏` → `空间光学扩展显示屏`.
- Matched face: `Resource Han Rounded CN ExtraLight`.
- Approximate size: 3.5 pt.
- Standard character step: about 1.346 mm.
- New glyphs were outlined; unchanged glyph paths were retained.
- Complete Chinese row was recentered with about 0.0014 mm residual center error.
- 300-DPI diff was confined to the actual engraving and its reference copy.

### P003 Max rear shell

- Source extension: `.ai`; real format: PDF 1.5.
- Replacement: outlined `Max` → outlined `Pro+` in `EyesCare Max`.
- Matched face: `Resource Han Rounded CN ExtraLight`.
- Approximate size: 5 pt.
- Original outline stroke: 0.25 pt.
- Original English-row center: 1132.68535 document pixels.
- Final center difference: about 0.005 px, or 0.0014 mm.
- Enlarged OCR confirmed `EyesCare Pro+`.
- Pixel diff changed only the intended English row; paths outside it were unchanged.
- Final PDF bytes were delivered under both `.ai` and `.pdf` names because the source workflow used PDF-backed Illustrator-compatible files.

## 8. Failure modes

- **Importer reports an invalid PDF/AI.** The `.ai` name hides SVG/XML. Detect magic bytes and copy to `.svg` first.
- **Target text is absent from extraction.** It is outlined. Locate it through bounds, crops, OCR, and glyph matching.
- **Full-drawing OCR misses the mark.** Crop tightly and enlarge 6–8×.
- **Replacement looks close but not exact.** Font, weight, point size, tracking, stroke, or baseline was guessed instead of measured.
- **Diff covers the whole page.** Baseline and candidate used different renderers, DPI, color profiles, page boxes, or antialiasing.
- **Longer wording drifts off-center.** The origin was preserved instead of the row's visual center.
- **A generated glyph differs from the old outline.** The local font version differs; compare multiple glyphs and preserve original outlines whenever possible.
- **XML namespace registration fails.** Avoid registering a default namespace with an invalid null prefix; preserve the parsed namespace map or use explicit qualified names.

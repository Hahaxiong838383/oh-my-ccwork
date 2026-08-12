from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.interpolate import RBFInterpolator


@dataclass(frozen=True)
class DemoConfig:
    screen_width: int = 1600
    screen_height: int = 360
    canvas_width: int = 1600
    canvas_height: int = 520
    footprint_width: int = 1500
    footprint_height: int = 480
    control_cols: int = 25
    control_rows: int = 11
    sample_cols: int = 57
    sample_rows: int = 21
    rbf_smoothing: float = 1.0e-5


@dataclass(frozen=True)
class AcceptanceResult:
    coverage_ratio: float
    mean_absolute_error: float
    p95_absolute_error: float
    invalid_uv_ratio: float
    passed: bool


def _normalized_grid(cols: int, rows: int) -> np.ndarray:
    x_values = np.linspace(0.0, 1.0, cols, dtype=np.float64)
    y_values = np.linspace(0.0, 1.0, rows, dtype=np.float64)
    grid_x, grid_y = np.meshgrid(x_values, y_values)
    return np.column_stack([grid_x.ravel(), grid_y.ravel()])


def _screen_to_observed(normalized_screen_points: np.ndarray) -> np.ndarray:
    """模拟挡风玻璃反射后的非线性位置，输出归一化观察坐标。"""
    screen_x = normalized_screen_points[:, 0]
    screen_y = normalized_screen_points[:, 1]
    centered_x = screen_x * 2.0 - 1.0
    centered_y = screen_y * 2.0 - 1.0

    horizontal_scale = 0.97 - 0.07 * centered_y + 0.025 * centered_x
    observed_x = 0.5 + 0.5 * centered_x * horizontal_scale
    observed_x += 0.018 * centered_y * (1.0 - centered_x**2)

    arch = 0.105 * (1.0 - centered_x**2)
    vertical_scale = 0.83 + 0.08 * centered_x
    observed_y = 0.5 + 0.5 * centered_y * vertical_scale
    observed_y -= arch
    observed_y += 0.025 * centered_x + 0.018 * centered_x * centered_y
    return np.column_stack([observed_x, observed_y])


def _fit_bidirectional_models(config: DemoConfig) -> tuple[RBFInterpolator, RBFInterpolator]:
    screen_points = _normalized_grid(config.control_cols, config.control_rows)
    observed_points = _screen_to_observed(screen_points)
    observed_to_screen = RBFInterpolator(
        observed_points,
        screen_points,
        kernel="thin_plate_spline",
        smoothing=config.rbf_smoothing,
    )
    screen_to_observed = RBFInterpolator(
        screen_points,
        observed_points,
        kernel="thin_plate_spline",
        smoothing=config.rbf_smoothing,
    )
    return observed_to_screen, screen_to_observed


def _observed_bounds(config: DemoConfig, screen_to_observed: RBFInterpolator) -> tuple[float, float, float, float]:
    dense_screen = _normalized_grid(config.sample_cols, config.sample_rows)
    dense_observed = screen_to_observed(dense_screen)
    min_x, min_y = dense_observed.min(axis=0)
    max_x, max_y = dense_observed.max(axis=0)
    margin_x = (max_x - min_x) * 0.005
    margin_y = (max_y - min_y) * 0.005
    return min_x - margin_x, min_y - margin_y, max_x + margin_x, max_y + margin_y


def _pixel_grid(width: int, height: int) -> np.ndarray:
    pixel_x, pixel_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    return np.column_stack([pixel_x.ravel(), pixel_y.ravel()])


def _observed_pixels_to_normalized(
    pixels: np.ndarray,
    width: int,
    height: int,
    bounds: tuple[float, float, float, float],
) -> np.ndarray:
    min_x, min_y, max_x, max_y = bounds
    normalized_x = min_x + pixels[:, 0] / max(width - 1, 1) * (max_x - min_x)
    normalized_y = min_y + pixels[:, 1] / max(height - 1, 1) * (max_y - min_y)
    return np.column_stack([normalized_x, normalized_y])


def _normalized_to_observed_pixels(
    normalized: np.ndarray,
    width: int,
    height: int,
    bounds: tuple[float, float, float, float],
) -> np.ndarray:
    min_x, min_y, max_x, max_y = bounds
    pixel_x = (normalized[:, 0] - min_x) / (max_x - min_x) * (width - 1)
    pixel_y = (normalized[:, 1] - min_y) / (max_y - min_y) * (height - 1)
    return np.column_stack([pixel_x, pixel_y])


def _build_forward_reflection_map(
    config: DemoConfig,
    observed_to_screen: RBFInterpolator,
    bounds: tuple[float, float, float, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    observed_pixels = _pixel_grid(config.footprint_width, config.footprint_height)
    observed_normalized = _observed_pixels_to_normalized(
        observed_pixels,
        config.footprint_width,
        config.footprint_height,
        bounds,
    )
    screen_normalized = observed_to_screen(observed_normalized)
    valid = (
        (screen_normalized[:, 0] >= 0.0)
        & (screen_normalized[:, 0] <= 1.0)
        & (screen_normalized[:, 1] >= 0.0)
        & (screen_normalized[:, 1] <= 1.0)
    )
    map_x = (screen_normalized[:, 0] * (config.screen_width - 1)).reshape(
        config.footprint_height,
        config.footprint_width,
    ).astype(np.float32)
    map_y = (screen_normalized[:, 1] * (config.screen_height - 1)).reshape(
        config.footprint_height,
        config.footprint_width,
    ).astype(np.float32)
    mask = (valid.reshape(config.footprint_height, config.footprint_width) * 255).astype(np.uint8)
    return map_x, map_y, mask


def _build_predistortion_map(
    config: DemoConfig,
    screen_to_observed: RBFInterpolator,
    bounds: tuple[float, float, float, float],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    screen_pixels = _pixel_grid(config.screen_width, config.screen_height)
    screen_normalized = np.column_stack(
        [
            screen_pixels[:, 0] / max(config.screen_width - 1, 1),
            screen_pixels[:, 1] / max(config.screen_height - 1, 1),
        ]
    )
    observed_normalized = screen_to_observed(screen_normalized)
    observed_pixels = _normalized_to_observed_pixels(
        observed_normalized,
        config.footprint_width,
        config.footprint_height,
        bounds,
    )
    map_x = observed_pixels[:, 0].reshape(config.screen_height, config.screen_width).astype(np.float32)
    map_y = observed_pixels[:, 1].reshape(config.screen_height, config.screen_width).astype(np.float32)
    invalid = (
        (map_x < 0.0)
        | (map_x > config.footprint_width - 1)
        | (map_y < 0.0)
        | (map_y > config.footprint_height - 1)
    )
    return map_x, map_y, invalid.astype(np.uint8)


def _font(size: int) -> ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def create_canvas(config: DemoConfig) -> np.ndarray:
    image = Image.new("RGB", (config.canvas_width, config.canvas_height), (8, 15, 28))
    draw = ImageDraw.Draw(image)

    grid_color = (48, 101, 145)
    major_color = (95, 205, 235)
    for x in range(0, config.canvas_width, 100):
        draw.line((x, 0, x, config.canvas_height), fill=grid_color, width=1)
    for y in range(0, config.canvas_height, 65):
        draw.line((0, y, config.canvas_width, y), fill=grid_color, width=1)
    for x in range(0, config.canvas_width, 400):
        draw.line((x, 0, x, config.canvas_height), fill=major_color, width=3)
    for y in range(0, config.canvas_height, 130):
        draw.line((0, y, config.canvas_width, y), fill=major_color, width=3)

    safe_top = (config.canvas_height - config.screen_height) // 2
    safe_bottom = safe_top + config.screen_height
    draw.rectangle(
        (5, safe_top, config.canvas_width - 6, safe_bottom),
        outline=(80, 245, 130),
        width=5,
    )
    draw.text((35, 20), "TOP EXTENDED CANVAS", fill=(255, 190, 70), font=_font(28))
    draw.text((35, safe_top + 18), "CORE SAFE AREA", fill=(90, 255, 150), font=_font(34))
    draw.text((35, safe_bottom + 22), "BOTTOM EXTENDED CANVAS", fill=(255, 190, 70), font=_font(28))

    center_x = config.canvas_width // 2
    center_y = config.canvas_height // 2
    draw.ellipse((center_x - 75, center_y - 75, center_x + 75, center_y + 75), outline=(255, 100, 100), width=7)
    draw.rectangle((center_x - 235, center_y - 105, center_x + 235, center_y + 105), outline=(245, 245, 245), width=5)
    draw.line((0, center_y, config.canvas_width, center_y), fill=(255, 255, 255), width=3)
    draw.line((center_x, 0, center_x, config.canvas_height), fill=(255, 255, 255), width=3)
    draw.text((center_x - 180, center_y - 26), "FULL FOOTPRINT", fill=(255, 255, 255), font=_font(42))

    return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _canvas_to_footprint(config: DemoConfig, canvas: np.ndarray, mask: np.ndarray) -> np.ndarray:
    resized = cv2.resize(canvas, (config.footprint_width, config.footprint_height), interpolation=cv2.INTER_LINEAR)
    return cv2.bitwise_and(resized, resized, mask=mask)


def _safe_canvas_to_footprint(config: DemoConfig, canvas: np.ndarray, mask: np.ndarray) -> np.ndarray:
    safe_top = (config.canvas_height - config.screen_height) // 2
    safe_content = canvas[safe_top : safe_top + config.screen_height]
    scale = min(
        config.footprint_width / config.screen_width,
        config.footprint_height / config.screen_height,
    )
    target_width = int(round(config.screen_width * scale))
    target_height = int(round(config.screen_height * scale))
    target = np.zeros((config.footprint_height, config.footprint_width, 3), dtype=np.uint8)
    resized = cv2.resize(safe_content, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    offset_x = (config.footprint_width - target_width) // 2
    offset_y = (config.footprint_height - target_height) // 2
    target[offset_y : offset_y + target_height, offset_x : offset_x + target_width] = resized
    return cv2.bitwise_and(target, target, mask=mask)


def _remap(source: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> np.ndarray:
    return cv2.remap(
        source,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0),
    )


def _save_image(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image):
        raise RuntimeError(f"无法写入图片：{path}")


def _annotated(title: str, image: np.ndarray, width: int = 900) -> np.ndarray:
    scale = width / image.shape[1]
    resized = cv2.resize(image, (width, max(1, int(round(image.shape[0] * scale)))))
    header = np.full((58, width, 3), (24, 31, 43), dtype=np.uint8)
    cv2.putText(header, title, (22, 39), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (245, 245, 245), 2, cv2.LINE_AA)
    return np.vstack([header, resized])


def _contact_sheet(items: list[tuple[str, np.ndarray]]) -> np.ndarray:
    cards = [_annotated(title, image) for title, image in items]
    card_height = max(card.shape[0] for card in cards)
    padded = []
    for card in cards:
        if card.shape[0] < card_height:
            pad = np.zeros((card_height - card.shape[0], card.shape[1], 3), dtype=np.uint8)
            card = np.vstack([card, pad])
        padded.append(card)
    rows = []
    for index in range(0, len(padded), 2):
        row = padded[index : index + 2]
        if len(row) == 1:
            row.append(np.zeros_like(row[0]))
        rows.append(np.hstack(row))
    return np.vstack(rows)


def _acceptance(
    target: np.ndarray,
    corrected: np.ndarray,
    mask: np.ndarray,
    invalid_map: np.ndarray,
) -> AcceptanceResult:
    valid_pixels = mask > 0
    target_smoothed = cv2.GaussianBlur(target, (5, 5), 0)
    corrected_smoothed = cv2.GaussianBlur(corrected, (5, 5), 0)
    difference = cv2.absdiff(target_smoothed, corrected_smoothed)
    sample = difference[valid_pixels]
    target_active = np.max(target, axis=2) > 2
    corrected_active = np.max(corrected, axis=2) > 2
    expected_active = valid_pixels & target_active
    coverage = float(
        np.count_nonzero(expected_active & corrected_active)
        / max(np.count_nonzero(expected_active), 1)
    )
    mean_error = float(sample.mean()) if sample.size else float("inf")
    p95_error = float(np.percentile(sample, 95)) if sample.size else float("inf")
    invalid_ratio = float(np.count_nonzero(invalid_map) / invalid_map.size)
    passed = coverage >= 0.99 and mean_error <= 4.0 and p95_error <= 12.0 and invalid_ratio <= 0.01
    return AcceptanceResult(
        coverage_ratio=coverage,
        mean_absolute_error=mean_error,
        p95_absolute_error=p95_error,
        invalid_uv_ratio=invalid_ratio,
        passed=passed,
    )


def run_demo(output_dir: Path, config: DemoConfig | None = None) -> AcceptanceResult:
    config = config or DemoConfig()
    output_dir.mkdir(parents=True, exist_ok=True)

    observed_to_screen, screen_to_observed = _fit_bidirectional_models(config)
    bounds = _observed_bounds(config, screen_to_observed)
    reflection_x, reflection_y, footprint_mask = _build_forward_reflection_map(
        config,
        observed_to_screen,
        bounds,
    )
    predistort_x, predistort_y, invalid_map = _build_predistortion_map(
        config,
        screen_to_observed,
        bounds,
    )

    canvas = create_canvas(config)
    target_full = _canvas_to_footprint(config, canvas, footprint_mask)
    target_safe = _safe_canvas_to_footprint(config, canvas, footprint_mask)

    uncorrected_screen = cv2.resize(
        canvas,
        (config.screen_width, config.screen_height),
        interpolation=cv2.INTER_LINEAR,
    )
    observed_uncorrected = _remap(uncorrected_screen, reflection_x, reflection_y)

    physical_predistorted = _remap(target_full, predistort_x, predistort_y)
    observed_corrected = _remap(physical_predistorted, reflection_x, reflection_y)
    physical_safe = _remap(target_safe, predistort_x, predistort_y)
    observed_safe = _remap(physical_safe, reflection_x, reflection_y)

    result = _acceptance(target_full, observed_corrected, footprint_mask, invalid_map)

    images = {
        "virtual_canvas.png": canvas,
        "footprint_mask.png": footprint_mask,
        "target_full_footprint.png": target_full,
        "target_safe_rect.png": target_safe,
        "observed_uncorrected.png": observed_uncorrected,
        "physical_predistorted.png": physical_predistorted,
        "observed_corrected.png": observed_corrected,
        "observed_safe_rect.png": observed_safe,
        "error_heatmap.png": cv2.applyColorMap(
            cv2.cvtColor(cv2.absdiff(target_full, observed_corrected), cv2.COLOR_BGR2GRAY),
            cv2.COLORMAP_TURBO,
        ),
    }
    for filename, image in images.items():
        _save_image(output_dir / filename, image)

    sheet = _contact_sheet(
        [
            ("1. Extended virtual canvas", canvas),
            ("2. Simulated reflection without correction", observed_uncorrected),
            ("3. Physical screen predistortion", physical_predistorted),
            ("4. Full-footprint corrected observation", observed_corrected),
            ("5. Safe-rectangle mode", observed_safe),
            ("6. Target full footprint", target_full),
        ]
    )
    _save_image(output_dir / "contact_sheet.png", sheet)

    report = {
        "config": asdict(config),
        "acceptance": asdict(result),
        "observed_bounds": {
            "min_x": bounds[0],
            "min_y": bounds[1],
            "max_x": bounds[2],
            "max_y": bounds[3],
        },
        "notes": [
            "全反射面模式使用比物理输出更高的虚拟画布。",
            "物理屏幕上的预畸变图本身应是弯曲和压缩的。",
            "校正结果只在固定观察位置成立。",
        ],
    }
    (output_dir / "acceptance_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result

const DEFAULT_STATE = {
  mode: "physical",
  canvasHeight: 520,
  arch: 0.105,
  verticalScale: 0.83,
  asymmetry: 0.08,
  tilt: 0.025,
  horizontalBend: 0.018,
  horizontalScale: 0.97,
  verticalShear: 0.018,
  meshCols: 28,
  meshRows: 12,
  showLabels: true,
  uploadedImage: null,
};

const CHANNEL_NAME = "nio-warp-display-demo-v1";
const STORAGE_KEY = "nio-warp-display-state-v1";

function readState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_STATE, ...saved, uploadedImage: null };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persistState(state) {
  const serializable = { ...state, uploadedImage: null };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
}

function rawWarp(point, state) {
  const centeredX = point.x * 2 - 1;
  const centeredY = point.y * 2 - 1;
  const horizontalScale = state.horizontalScale - 0.07 * centeredY + 0.025 * centeredX;
  const x = 0.5
    + 0.5 * centeredX * horizontalScale
    + state.horizontalBend * centeredY * (1 - centeredX * centeredX);
  const y = 0.5
    + 0.5 * centeredY * (state.verticalScale + state.asymmetry * centeredX)
    - state.arch * (1 - centeredX * centeredX)
    + state.tilt * centeredX
    + state.verticalShear * centeredX * centeredY;
  return { x, y };
}

function computeBounds(state) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let row = 0; row <= 30; row += 1) {
    for (let col = 0; col <= 60; col += 1) {
      const point = rawWarp({ x: col / 60, y: row / 30 }, state);
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  const marginX = (maxX - minX) * 0.006;
  const marginY = (maxY - minY) * 0.006;
  return {
    minX: minX - marginX,
    minY: minY - marginY,
    maxX: maxX + marginX,
    maxY: maxY + marginY,
  };
}

function warpPoint(point, state, bounds) {
  const warped = rawWarp(point, state);
  return {
    x: (warped.x - bounds.minX) / (bounds.maxX - bounds.minX),
    y: (warped.y - bounds.minY) / (bounds.maxY - bounds.minY),
  };
}

function fitCanvas(canvas) {
  const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, ratio };
}

function fontFamily() {
  return '"Avenir Next Condensed", "Helvetica Neue", sans-serif';
}

function drawTargetCanvas(canvas, state, uploadedImage) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const safeFraction = Math.min(1, 360 / state.canvasHeight);
  const safeTop = (1 - safeFraction) * height * 0.5;
  const safeBottom = height - safeTop;

  ctx.clearRect(0, 0, width, height);
  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, "#071521");
  background.addColorStop(0.52, "#0b2533");
  background.addColorStop(1, "#061019");
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(74, 190, 228, .36)";
  ctx.lineWidth = Math.max(1, width / 1600);
  for (let x = 0; x <= width; x += width / 16) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 8) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(116, 226, 255, .9)";
  ctx.lineWidth = Math.max(2, width / 800);
  for (let x = 0; x <= width; x += width / 4) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(245, 169, 62, .13)";
  ctx.fillRect(0, 0, width, safeTop);
  ctx.fillRect(0, safeBottom, width, height - safeBottom);
  ctx.strokeStyle = "#54ff9f";
  ctx.lineWidth = Math.max(3, width / 500);
  ctx.strokeRect(3, safeTop, width - 6, safeBottom - safeTop);

  if (uploadedImage?.complete && uploadedImage.naturalWidth > 0) {
    const areaWidth = width * 0.5;
    const areaHeight = (safeBottom - safeTop) * 0.62;
    const scale = Math.min(areaWidth / uploadedImage.naturalWidth, areaHeight / uploadedImage.naturalHeight);
    const drawWidth = uploadedImage.naturalWidth * scale;
    const drawHeight = uploadedImage.naturalHeight * scale;
    const x = (width - drawWidth) * 0.5;
    const y = safeTop + (safeBottom - safeTop - drawHeight) * 0.5;
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.drawImage(uploadedImage, x, y, drawWidth, drawHeight);
    ctx.restore();
  }

  const centerX = width * 0.5;
  const centerY = height * 0.5;
  ctx.strokeStyle = "#ff6f6b";
  ctx.lineWidth = Math.max(4, width / 380);
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.min(width, height) * 0.13, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,.94)";
  ctx.lineWidth = Math.max(2, width / 700);
  ctx.strokeRect(width * 0.36, centerY - height * 0.16, width * 0.28, height * 0.32);
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.moveTo(centerX, 0);
  ctx.lineTo(centerX, height);
  ctx.stroke();

  if (state.showLabels) {
    ctx.font = `700 ${Math.max(18, width * 0.026)}px ${fontFamily()}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f4f7f5";
    ctx.fillText("FULL FOOTPRINT", centerX, centerY);

    ctx.font = `700 ${Math.max(14, width * 0.016)}px ${fontFamily()}`;
    ctx.textAlign = "left";
    ctx.fillStyle = "#f7b548";
    ctx.fillText("TOP EXTENDED CANVAS", width * 0.025, Math.max(20, safeTop * 0.45));
    ctx.fillText("BOTTOM EXTENDED CANVAS", width * 0.025, safeBottom + Math.max(20, (height - safeBottom) * 0.45));
    ctx.fillStyle = "#54ff9f";
    ctx.fillText("CORE SAFE AREA", width * 0.025, safeTop + Math.max(22, height * 0.045));
  }
}

function affineFromTriangles(source, destination) {
  const [s0, s1, s2] = source;
  const [d0, d1, d2] = destination;
  const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  return {
    a: (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator,
    b: (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator,
    c: (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator,
    d: (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator,
    e: (
      d0.x * (s1.x * s2.y - s2.x * s1.y)
      + d1.x * (s2.x * s0.y - s0.x * s2.y)
      + d2.x * (s0.x * s1.y - s1.x * s0.y)
    ) / denominator,
    f: (
      d0.y * (s1.x * s2.y - s2.x * s1.y)
      + d1.y * (s2.x * s0.y - s0.x * s2.y)
      + d2.y * (s0.x * s1.y - s1.x * s0.y)
    ) / denominator,
  };
}

function drawTriangle(ctx, sourceCanvas, source, destination) {
  const transform = affineFromTriangles(source, destination);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(destination[0].x, destination[0].y);
  ctx.lineTo(destination[1].x, destination[1].y);
  ctx.lineTo(destination[2].x, destination[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
}

function meshRender(ctx, sourceCanvas, state, direction) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const bounds = computeBounds(state);
  const cols = state.meshCols;
  const rows = state.meshRows;

  const sourcePoint = (x, y) => {
    const point = direction === "predistort"
      ? warpPoint({ x, y }, state, bounds)
      : { x, y };
    return { x: point.x * sourceCanvas.width, y: point.y * sourceCanvas.height };
  };
  const destinationPoint = (x, y) => {
    const point = direction === "predistort"
      ? { x, y }
      : warpPoint({ x, y }, state, bounds);
    return { x: point.x * width, y: point.y * height };
  };

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = col / cols;
      const x1 = (col + 1) / cols;
      const y0 = row / rows;
      const y1 = (row + 1) / rows;
      const p00 = { x: x0, y: y0 };
      const p10 = { x: x1, y: y0 };
      const p01 = { x: x0, y: y1 };
      const p11 = { x: x1, y: y1 };

      drawTriangle(
        ctx,
        sourceCanvas,
        [sourcePoint(p00.x, p00.y), sourcePoint(p10.x, p10.y), sourcePoint(p11.x, p11.y)],
        [destinationPoint(p00.x, p00.y), destinationPoint(p10.x, p10.y), destinationPoint(p11.x, p11.y)],
      );
      drawTriangle(
        ctx,
        sourceCanvas,
        [sourcePoint(p00.x, p00.y), sourcePoint(p11.x, p11.y), sourcePoint(p01.x, p01.y)],
        [destinationPoint(p00.x, p00.y), destinationPoint(p11.x, p11.y), destinationPoint(p01.x, p01.y)],
      );
    }
  }
}

function footprintPath(ctx, state) {
  const bounds = computeBounds(state);
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const samples = [];
  for (let i = 0; i <= 80; i += 1) samples.push(warpPoint({ x: i / 80, y: 0 }, state, bounds));
  for (let i = 1; i <= 30; i += 1) samples.push(warpPoint({ x: 1, y: i / 30 }, state, bounds));
  for (let i = 79; i >= 0; i -= 1) samples.push(warpPoint({ x: i / 80, y: 1 }, state, bounds));
  for (let i = 29; i > 0; i -= 1) samples.push(warpPoint({ x: 0, y: i / 30 }, state, bounds));
  ctx.beginPath();
  samples.forEach((point, index) => {
    const x = point.x * width;
    const y = point.y * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

class WarpRenderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.state = state;
    this.target = document.createElement("canvas");
    this.physical = document.createElement("canvas");
    this.uploadedImage = null;
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(canvas);
  }

  setState(state) {
    this.state = state;
    if (state.uploadedImage && state.uploadedImage !== this.uploadedImage?.src) {
      const image = new Image();
      image.onload = () => {
        this.uploadedImage = image;
        this.render();
      };
      image.src = state.uploadedImage;
    } else if (!state.uploadedImage) {
      this.uploadedImage = null;
    }
    this.render();
  }

  render(mode = this.state.mode) {
    const { width, height } = fitCanvas(this.canvas);
    this.target.width = width;
    this.target.height = height;
    this.physical.width = width;
    this.physical.height = height;
    drawTargetCanvas(this.target, this.state, this.uploadedImage);

    const ctx = this.canvas.getContext("2d");
    ctx.resetTransform();
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#020609";
    ctx.fillRect(0, 0, width, height);

    if (mode === "source") {
      ctx.drawImage(this.target, 0, 0, width, height);
      return;
    }
    if (mode === "physical") {
      meshRender(ctx, this.target, this.state, "predistort");
      return;
    }
    if (mode === "uncorrected") {
      meshRender(ctx, this.target, this.state, "forward");
      return;
    }
    if (mode === "corrected") {
      const physicalContext = this.physical.getContext("2d");
      physicalContext.clearRect(0, 0, width, height);
      physicalContext.fillStyle = "#020609";
      physicalContext.fillRect(0, 0, width, height);
      meshRender(physicalContext, this.target, this.state, "predistort");
      meshRender(ctx, this.physical, this.state, "forward");
      ctx.strokeStyle = "rgba(255, 222, 91, .85)";
      ctx.lineWidth = Math.max(2, width / 900);
      footprintPath(ctx, this.state);
      ctx.stroke();
    }
  }
}

window.NioWarp = {
  DEFAULT_STATE,
  CHANNEL_NAME,
  STORAGE_KEY,
  WarpRenderer,
  persistState,
  readState,
};

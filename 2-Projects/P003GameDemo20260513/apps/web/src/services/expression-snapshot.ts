import { useAppStore } from '../store/app-store';

// D6 P1 V2：扩到 13 标签（川哥要"越丰富越好"，judge 不稳没关系）。
// 13 标签分 3 组：
// - 正向情绪：happy / excited
// - 负向情绪：sad / tired / bored / confused / shy
// - 中性 / 认知：curious / focused / surprised / thinking / neutral
// - 兜底：no_face
export type ExpressionLabel =
  | 'happy'
  | 'excited'
  | 'sad'
  | 'tired'
  | 'bored'
  | 'confused'
  | 'shy'
  | 'curious'
  | 'focused'
  | 'surprised'
  | 'thinking'
  | 'neutral'
  | 'no_face';

export interface ExpressionRef {
  expr: ExpressionLabel;
  confidence: number;
  at: number;
}

interface VisionResponse {
  expr: ExpressionLabel;
  confidence: number;
  latencyMs: number;
}

interface ExpressionSnapshotInstance {
  bindVideoElement(video: HTMLVideoElement | null): void;
  snap(): Promise<void>;
  snapIfStale(): Promise<void>;
  getExpressionRef(): Readonly<ExpressionRef>;
  disposeCamera(): void;
}

// D6 P1 debug：暴露内部状态给 DebugBar 显示
export interface ExpressionDebugInfo {
  bound: boolean;
  stream: boolean;
  mdev: boolean;
  unavailable: boolean;
  lastSkip: string;
}
let lastSkipReason = '-';
export function getExpressionDebug(): ExpressionDebugInfo {
  return {
    bound: !!boundVideo,
    stream: !!cameraStream,
    mdev: typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    unavailable: cameraUnavailable,
    lastSkip: lastSkipReason,
  };
}

const CAMERA_UNAVAILABLE_SESSION_KEY = 'p003_camera_unavailable';
const MAX_BASE64_LENGTH = 50 * 1024;
export const EXPRESSION_TTL_MS = 3_000;
// D6 P1 hotfix：server 端 Gemini 超时已提到 8s（30KB 图实测 3018ms 超时），
// client 给 server 留 4s 余量。
export const POST_TIMEOUT_MS = 12_000;

const currentRef: ExpressionRef = {
  expr: 'neutral',
  confidence: 0,
  at: 0,
};

let sharedInstance: ExpressionSnapshotInstance | null = null;
let inFlightPromise: Promise<void> | null = null;
let boundVideo: HTMLVideoElement | null = null;
let cameraStream: MediaStream | null = null;
let cameraUnavailable = loadCameraUnavailable();

function loadCameraUnavailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(CAMERA_UNAVAILABLE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function syncCameraUnavailable(flag: boolean): void {
  cameraUnavailable = flag;
  useAppStore.getState().setCameraUnavailable(flag);
  if (typeof window === 'undefined') return;
  try {
    if (flag) {
      window.sessionStorage.setItem(CAMERA_UNAVAILABLE_SESSION_KEY, '1');
    } else {
      window.sessionStorage.removeItem(CAMERA_UNAVAILABLE_SESSION_KEY);
    }
  } catch {
    // ignore quota errors
  }
}

function setNeutralNow(): void {
  currentRef.expr = 'neutral';
  currentRef.confidence = 0;
  currentRef.at = Date.now();
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('blob_to_base64_failed'));
    reader.onload = () => {
      const raw = typeof reader.result === 'string' ? reader.result : '';
      const comma = raw.indexOf(',');
      resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
    };
    reader.readAsDataURL(blob);
  });
}

function isExpressionLabel(value: unknown): value is ExpressionLabel {
  return (
    value === 'happy' ||
    value === 'tired' ||
    value === 'curious' ||
    value === 'neutral' ||
    value === 'no_face'
  );
}

function parseVisionResponse(raw: unknown): VisionResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (!isExpressionLabel(candidate.expr)) return null;
  if (typeof candidate.confidence !== 'number') return null;
  if (typeof candidate.latencyMs !== 'number') return null;
  return {
    expr: candidate.expr,
    confidence: candidate.confidence,
    latencyMs: candidate.latencyMs,
  };
}

async function waitVideoReady(video: HTMLVideoElement): Promise<boolean> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve(video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    }, 300);
    const onReady = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('canplay', onReady);
    };
    video.addEventListener('loadeddata', onReady);
    video.addEventListener('canplay', onReady);
  });
}

async function ensureCameraReady(): Promise<boolean> {
  if (cameraUnavailable) {
    lastSkipReason = 'unavailable_flag';
    if (import.meta.env.DEV) console.warn('[expr-snap] skip: cameraUnavailable=true');
    return false;
  }
  if (!boundVideo) {
    lastSkipReason = 'no_bound_video';
    if (import.meta.env.DEV) console.warn('[expr-snap] skip: boundVideo=null');
    return false;
  }
  if (cameraStream) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    lastSkipReason = 'mdev_undefined';
    if (import.meta.env.DEV) console.warn('[expr-snap] fail: navigator.mediaDevices undefined');
    syncCameraUnavailable(true);
    return false;
  }
  try {
    // D6 P1 hotfix：iOS Safari 不指定 facingMode 默认拿后置摄像头
    // → 拍川哥背后的环境而不是他的脸 → Gemini 永远 no_face@0。
    // 强制前置 user-facing；如果设备没前置（罕见），降级到任意可用。
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        facingMode: { ideal: 'user' },
      },
      audio: false,
    });
    boundVideo.srcObject = cameraStream;
    try {
      await boundVideo.play();
    } catch {
      // Safari 可能仍在自动播放策略里，后续抓拍前再等 readyState
    }
    syncCameraUnavailable(false);
    lastSkipReason = 'ready';
    if (import.meta.env.DEV) console.warn('[expr-snap] camera ready ✅');
    return true;
  } catch (err) {
    lastSkipReason = `getUserMedia_${(err as Error)?.name ?? 'err'}`;
    if (import.meta.env.DEV) console.warn('[expr-snap] getUserMedia rejected:', err);
    syncCameraUnavailable(true);
    return false;
  }
}

// D6 P1 速度优化：320×240 q=0.7 → 160×120 q=0.6（base64 -65%，
// 上传 + Gemini 处理双减，准确率几乎不变）。
const CAPTURE_W = 160;
const CAPTURE_H = 120;
const CAPTURE_Q = 0.6;

async function captureJpegBase64(): Promise<string | null> {
  if (!boundVideo) return null;
  const ready = await waitVideoReady(boundVideo);
  if (!ready || boundVideo.videoWidth <= 0 || boundVideo.videoHeight <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = CAPTURE_W;
  canvas.height = CAPTURE_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(boundVideo, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', CAPTURE_Q);
  });
  if (!blob) return null;
  const jpegBase64 = await blobToBase64(blob);
  if (!jpegBase64 || jpegBase64.length > MAX_BASE64_LENGTH) return null;
  return jpegBase64;
}

async function doSnap(): Promise<void> {
  const ready = await ensureCameraReady();
  if (!ready) {
    setNeutralNow();
    return;
  }

  const jpegBase64 = await captureJpegBase64();
  if (!jpegBase64) {
    lastSkipReason = 'capture_fail';
    if (import.meta.env.DEV) console.warn('[expr-snap] capture failed (video not ready or canvas blob)');
    setNeutralNow();
    return;
  }
  lastSkipReason = 'posting';

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    if (import.meta.env.DEV) console.warn('[expr-snap] POST /api/vision/expression jpegLen=', jpegBase64.length);
    const resp = await fetch('/api/vision/expression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpegBase64 }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      lastSkipReason = `HTTP_${resp.status}`;
      if (import.meta.env.DEV) console.warn('[expr-snap] HTTP', resp.status);
      setNeutralNow();
      return;
    }
    const parsed = parseVisionResponse(await resp.json());
    if (!parsed) {
      lastSkipReason = 'parse_fail';
      if (import.meta.env.DEV) console.warn('[expr-snap] parse failed');
      setNeutralNow();
      return;
    }
    if (import.meta.env.DEV) console.warn('[expr-snap] result:', parsed);
    currentRef.confidence = parsed.confidence;
    // D6 P1 hotfix v3：阈值 0.6 → 0.5（gemini 评审强烈建议"秒回 > 准确"，
    // 万金油误判也胜过冷场）。no_face 仍直接 → neutral。
    currentRef.expr = parsed.confidence < 0.5 || parsed.expr === 'no_face' ? 'neutral' : parsed.expr;
    lastSkipReason = `ok:${parsed.expr}@${parsed.confidence.toFixed(2)}`;
    currentRef.at = Date.now();
  } catch (err) {
    const e = err as { name?: string; message?: string };
    lastSkipReason = `fetch_${e?.name ?? 'err'}_${(e?.message ?? '').slice(0, 30)}`;
    if (import.meta.env.DEV) console.warn('[expr-snap] fetch threw:', err);
    setNeutralNow();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function createExpressionSnapshot(): ExpressionSnapshotInstance {
  return {
    bindVideoElement(video: HTMLVideoElement | null) {
      boundVideo = video;
      useAppStore.getState().setCameraUnavailable(cameraUnavailable);
      if (boundVideo && cameraStream) {
        boundVideo.srcObject = cameraStream;
      }
    },
    snap(): Promise<void> {
      if (cameraUnavailable) {
        setNeutralNow();
        return Promise.resolve();
      }
      if (inFlightPromise) return inFlightPromise;
      inFlightPromise = doSnap().finally(() => {
        inFlightPromise = null;
      });
      return inFlightPromise;
    },
    snapIfStale(): Promise<void> {
      if (Date.now() - currentRef.at < EXPRESSION_TTL_MS) return Promise.resolve();
      return this.snap();
    },
    getExpressionRef(): Readonly<ExpressionRef> {
      return currentRef;
    },
    disposeCamera(): void {
      if (cameraStream) {
        for (const track of cameraStream.getTracks()) track.stop();
        cameraStream = null;
      }
      if (boundVideo) {
        boundVideo.srcObject = null;
      }
    },
  };
}

export function getExpressionSnapshot(): ExpressionSnapshotInstance {
  if (!sharedInstance) sharedInstance = createExpressionSnapshot();
  return sharedInstance;
}

export function requestCameraPermissionAndSnap(): Promise<void> {
  return getExpressionSnapshot().snap();
}

export function snap(): Promise<void> {
  return getExpressionSnapshot().snap();
}

export function snapIfStale(): Promise<void> {
  return getExpressionSnapshot().snapIfStale();
}

export function getExpressionRef(): Readonly<ExpressionRef> {
  return getExpressionSnapshot().getExpressionRef();
}

export function disposeCamera(): void {
  getExpressionSnapshot().disposeCamera();
}


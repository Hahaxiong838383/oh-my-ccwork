// 自托管 MediaPipe wasm + model 文件，不走境外 CDN
// 国内访问 cdn.jsdelivr.net wasm 超时 + storage.googleapis.com 大概率被墙
// 改走 my.chenchuan.cc/mediapipe/，dev 和 prod 路径一致由 Next.js 静态服务
// 文件在 public/mediapipe/（不入 git，~44MB，rsync 单独同步到 VPS）
const WASM_CDN = '/mediapipe/wasm'
const FACE_MODEL_URL = '/mediapipe/models/face_landmarker.task'
const HAND_MODEL_URL = '/mediapipe/models/hand_landmarker.task'

type MediaPipeLandmarkers = {
  faceLandmarker: any
  handLandmarker: any
}

let landmarkerPromise: Promise<MediaPipeLandmarkers> | null = null
let consolePatched = false

// MediaPipe wasm 内部用 emscripten printf 输出 INFO 日志（例如 "Created TensorFlow Lite XNNPACK delegate"），
// emscripten 默认把 wasm stdout 走 console.error，Next.js dev overlay 会误报为错误。
// 这里一次性拦截：栈含 mediapipe / vision_wasm_internal 的 console.error → 降级为 console.log。
function patchConsoleForMediaPipe(): void {
  if (consolePatched || typeof window === 'undefined') return
  consolePatched = true
  const origError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    const stack = new Error().stack ?? ''
    if (stack.includes('mediapipe') || stack.includes('vision_wasm_internal')) {
      // eslint-disable-next-line no-console
      console.log('[mediapipe-info]', ...args)
      return
    }
    origError(...args)
  }
}

export async function loadMediaPipeLandmarkers(): Promise<MediaPipeLandmarkers> {
  if (landmarkerPromise) {
    return landmarkerPromise
  }

  patchConsoleForMediaPipe()

  landmarkerPromise = (async () => {
    const vision = await import('@mediapipe/tasks-vision')
    const filesetResolver = await vision.FilesetResolver.forVisionTasks(WASM_CDN)

    const [faceLandmarker, handLandmarker] = await Promise.all([
      vision.FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: FACE_MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      }),
      vision.HandLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: HAND_MODEL_URL,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
      }),
    ])

    return {
      faceLandmarker,
      handLandmarker,
    }
  })().catch((error) => {
    landmarkerPromise = null
    throw error
  })

  return landmarkerPromise
}

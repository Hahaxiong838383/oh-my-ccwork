// One-Euro Filter
// 参考：Casiez et al. 2012 "1€ filter: a simple speed-based low-pass filter for
// noisy input in interactive systems" (CHI'12)
// https://gery.casiez.net/1euro/
//
// 核心思路：自适应低通——低速时强平滑（去抖），高速时弱平滑（少滞后）。
// 这是人机交互（眼动 / 手势）的标配滤波器，比固定 α 的一阶低通效果好得多。
//
// 实践参数（仅供参考，需结合实际信号调）：
//   minCutoff = 1.0    // 最低截止频率，越小越稳但越延迟
//   beta = 0.007       // 速度补偿系数，越大对快动作越敏感
//   dCutoff = 1.0      // 速度本身的低通参数

function smoothingFactor(timeElapsed: number, cutoff: number): number {
  const r = 2 * Math.PI * cutoff * timeElapsed
  return r / (r + 1)
}

function exponentialSmoothing(alpha: number, value: number, prev: number): number {
  return alpha * value + (1 - alpha) * prev
}

export class OneEuroFilter {
  private minCutoff: number
  private beta: number
  private dCutoff: number
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev = 0

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff
    this.beta = beta
    this.dCutoff = dCutoff
  }

  reset(): void {
    this.xPrev = null
    this.dxPrev = 0
    this.tPrev = 0
  }

  filter(value: number, timestamp: number): number {
    if (this.xPrev === null) {
      this.xPrev = value
      this.tPrev = timestamp
      return value
    }

    const dt = Math.max((timestamp - this.tPrev) / 1000, 0.001)
    const dxRaw = (value - this.xPrev) / dt
    const aD = smoothingFactor(dt, this.dCutoff)
    const dxHat = exponentialSmoothing(aD, dxRaw, this.dxPrev)

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = smoothingFactor(dt, cutoff)
    const xHat = exponentialSmoothing(a, value, this.xPrev)

    this.xPrev = xHat
    this.dxPrev = dxHat
    this.tPrev = timestamp

    return xHat
  }
}

// 2D 包装：两个独立 OneEuro 实例，x/y 分轴滤波
export class OneEuroFilter2D {
  private fx: OneEuroFilter
  private fy: OneEuroFilter

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff)
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff)
  }

  reset(): void {
    this.fx.reset()
    this.fy.reset()
  }

  filter(x: number, y: number, timestamp: number): { x: number; y: number } {
    return {
      x: this.fx.filter(x, timestamp),
      y: this.fy.filter(y, timestamp),
    }
  }
}

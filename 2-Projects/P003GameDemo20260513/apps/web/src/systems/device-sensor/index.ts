/**
 * 设备传感器抽象层
 *
 * V1.0 真硬件信号：霍尔开关、人体传感器、实体按键
 * demo 阶段软模拟：visibilitychange + mousemove + 设备外壳按钮
 *
 * 对状态机暴露统一接口，未来切真硬件只换实现
 */

export type Unsubscribe = () => void;

export interface DeviceSensor {
  onLidOpen(cb: () => void): Unsubscribe;
  onLidClose(cb: () => void): Unsubscribe;
  onUserPresent(cb: () => void): Unsubscribe;
  onUserAway(cb: (durationMs: number) => void): Unsubscribe;
}

// TODO M0: 实现 WebDeviceSensor（visibilitychange + mousemove + custom event from PowerButton）
// TODO V1.5: 实现 RealDeviceSensor（接 Tauri/Capacitor 原生 SDK）

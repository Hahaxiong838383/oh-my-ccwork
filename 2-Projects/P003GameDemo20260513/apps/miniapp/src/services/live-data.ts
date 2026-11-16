import type { DashboardDetails } from './real-details';
export type BoundDevice = { sn: string; publicId: string; note: string; status: string; brainOpened: boolean };
export type DeviceSnapshot = {
  details?: DashboardDetails;
  online: boolean;
  updatedAtMs: number | null;
  present: boolean | null;
  brightnessLevel: number | null;
  imageDistanceM: number | null;
  imageDistanceState: string | null;
};
export interface LiveDataApi {
  hasSession(): boolean;
  saveSession(token: string): void;
  clearSession(): void;
  sendCode(phone: string): Promise<void>;
  login(phone: string, code: string): Promise<{ token: string }>;
  getDevices(): Promise<BoundDevice[]>;
  getSnapshot(publicId: string): Promise<DeviceSnapshot>;
}

export function snapshotView(snapshot: DeviceSnapshot | null) {
  const received = Boolean(snapshot && snapshot.updatedAtMs !== null && Number.isFinite(snapshot.updatedAtMs) && snapshot.updatedAtMs > 0);
  return {
    availability: !received ? 'no_data' : snapshot!.online ? 'available' : 'stale',
    onlineText: !received ? '尚无上报' : snapshot!.online ? '近期有上报' : '近期未上报',
    brightness: received && snapshot!.brightnessLevel !== null ? `${snapshot!.brightnessLevel} 档` : '暂无数据',
    presence: !received || snapshot!.present === null ? '暂无数据' : snapshot!.present ? '有人' : '无人',
    distance: received && snapshot!.imageDistanceState === 'valid' && snapshot!.imageDistanceM !== null ? `${snapshot!.imageDistanceM} 米` : '暂无数据',
  };
}

export type LiveDataState = {
  signedIn: boolean;
  devices: BoundDevice[];
  selectedId: string;
  snapshot: DeviceSnapshot | null;
  busy: boolean;
  sendingCode: boolean;
  loaded: boolean;
  error: string;
  message: string;
  retryAt: number;
};
const emptyState = (signedIn: boolean): LiveDataState => ({ signedIn, devices: [], selectedId: '', snapshot: null, busy: false, sendingCode: false, loaded: false, error: '', message: '', retryAt: 0 });
const phoneValid = (phone: string) => /^1\d{10}$/.test(phone);

export function liveErrorMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return '登录已过期，请重新登录';
  if (status === 403 || status === 404) return '该设备当前不可访问，请刷新设备列表';
  if (status === 429) return '请求较频繁，请稍后重试';
  if (status === 400) return '手机号或验证码不正确，请检查后重试';
  if (status && status >= 500) return '服务暂时不可用，请稍后重试';
  return '网络连接失败，请检查网络后重试';
}

/** 不持久化设备数据；每次切换账号使之前的异步响应失效。 */
export class LiveDataController {
  state: LiveDataState;
  private version = 0;
  private listeners = new Set<(state: LiveDataState) => void>();
  constructor(private readonly api: LiveDataApi) { this.state = emptyState(api.hasSession()); }
  subscribe(listener: (state: LiveDataState) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private update(patch: Partial<LiveDataState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener(this.state));
  }
  logout() {
    this.version += 1;
    this.api.clearSession();
    this.update(emptyState(false));
  }
  private fail(error: unknown, version: number) {
    if (version !== this.version) return;
    if ((error as { status?: number } | null)?.status === 401) this.logout();
    this.update({ busy: false, snapshot: null, error: liveErrorMessage(error) });
  }
  async sendCode(phone: string) {
    if (this.state.sendingCode || this.state.retryAt > Date.now()) return;
    if (!phoneValid(phone)) { this.update({ error: '请输入正确的11位手机号' }); return; }
    const version = this.version;
    this.update({ sendingCode: true, error: '', message: '' });
    try {
      await this.api.sendCode(phone);
      if (version === this.version) this.update({ message: '验证码已发送，请查收短信', retryAt: Date.now() + 60_000 });
    } catch (error) {
      if (version !== this.version) return;
      const retry = Number((error as { retryAfterSeconds?: number }).retryAfterSeconds);
      this.update({ error: liveErrorMessage(error), retryAt: (error as { status?: number }).status === 429 ? Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : 60) * 1000 : 0 });
    } finally {
      if (version === this.version) this.update({ sendingCode: false });
    }
  }
  async login(phone: string, code: string) {
    if (!phoneValid(phone) || !/^\d{6}$/.test(code)) { this.update({ error: '请输入正确的手机号和6位验证码' }); return; }
    const version = ++this.version;
    this.api.clearSession();
    this.update({ ...emptyState(false), busy: true, retryAt: this.state.retryAt });
    try {
      const result = await this.api.login(phone, code);
      if (version !== this.version) return;
      this.api.saveSession(result.token);
      this.update({ signedIn: true, busy: false });
      await this.refresh();
    } catch (error) {
      if (version !== this.version) return;
      const failure = error as { status?: number; payload?: { error?: string } };
      this.update({ busy: false, error: failure.status === 401 || failure.payload?.error === 'code_invalid' ? '验证码错误或已过期，请重新输入' : liveErrorMessage(error) });
    }
  }
  async refresh() {
    if (!this.state.signedIn) return;
    const version = ++this.version;
    const previousId = this.state.selectedId;
    this.update({ devices: [], selectedId: '', snapshot: null, busy: true, loaded: false, error: '', message: '' });
    try {
      const devices = await this.api.getDevices();
      if (version !== this.version) return;
      const selectedId = devices.find(item => item.publicId === previousId)?.publicId || devices[0]?.publicId || '';
      this.update({ devices, selectedId, loaded: true });
      if (selectedId) await this.loadSnapshot(selectedId, version);
      else this.update({ busy: false });
    } catch (error) { this.fail(error, version); }
  }
  async selectDevice(publicId: string) {
    if (!this.state.signedIn || !this.state.devices.some(item => item.publicId === publicId)) return;
    const version = ++this.version;
    this.update({ selectedId: publicId, snapshot: null, busy: true, error: '' });
    await this.loadSnapshot(publicId, version);
  }
  private async loadSnapshot(publicId: string, version: number) {
    try {
      const snapshot = await this.api.getSnapshot(publicId);
      if (version === this.version) this.update({ snapshot, busy: false });
    } catch (error) { this.fail(error, version); }
  }
}

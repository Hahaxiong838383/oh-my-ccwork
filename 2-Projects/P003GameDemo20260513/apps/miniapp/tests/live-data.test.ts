import { describe, expect, it, vi } from 'vitest';
import { LiveDataController, snapshotView, type BoundDevice, type DeviceSnapshot, type LiveDataApi } from '../src/services/live-data';

const device: BoundDevice = { sn: 'TEST-SN-A', publicId: 'dev_a', note: '测试读写台', status: 'active', brainOpened: true };
const snapshot: DeviceSnapshot = { online: true, updatedAtMs: 1793260800000, present: false, brightnessLevel: 0, imageDistanceM: null, imageDistanceState: null };

function fixture(overrides: Partial<LiveDataApi> = {}) {
  let token = 'account-a';
  const api: LiveDataApi = {
    hasSession: () => Boolean(token),
    saveSession: value => { token = value; },
    clearSession: () => { token = ''; },
    sendCode: async () => undefined,
    login: async () => ({ token: 'account-b' }),
    getDevices: async () => [device],
    getSnapshot: async () => snapshot,
    ...overrides,
  };
  return { api, controller: new LiveDataController(api), token: () => token };
}

describe('真实设备状态', () => {
  it('零亮度和无人是有效数据，未知视距不显示为0', () => {
    expect(snapshotView(snapshot)).toMatchObject({ availability: 'available', brightness: '0 档', presence: '无人', distance: '暂无数据', onlineText: '近期有上报' });
  });

  it('没有快照时不把台账active或默认false解释为在线/离线', () => {
    expect(snapshotView({ ...snapshot, online: false, updatedAtMs: null })).toMatchObject({ availability: 'no_data', brightness: '暂无数据', presence: '暂无数据', onlineText: '尚无上报' });
  });

  it('超时快照标为近期未上报而不推断网络断开，视距无效时不展示旧数值', () => {
    expect(snapshotView({ ...snapshot, online: false, imageDistanceM: 3, imageDistanceState: 'invalid' })).toMatchObject({ availability: 'stale', onlineText: '近期未上报', distance: '暂无数据' });
  });
});

describe('真实首页账号生命周期', () => {
  it('读取账号列表后只请求列表中设备的publicId', async () => {
    const ids: string[] = [];
    const { controller } = fixture({ getSnapshot: async id => { ids.push(id); return snapshot; } });
    await controller.refresh();
    expect(ids).toEqual(['dev_a']);
    expect(controller.state).toMatchObject({ signedIn: true, selectedId: 'dev_a', snapshot, busy: false, error: '' });
    await controller.selectDevice('somebody-elses-device');
    expect(ids).toEqual(['dev_a']);
  });

  it('确认没有设备与服务异常分别返回，不回落演示值', async () => {
    const empty = fixture({ getDevices: async () => [] });
    await empty.controller.refresh();
    expect(empty.controller.state).toMatchObject({ devices: [], snapshot: null, error: '', loaded: true });
    const failed = fixture({ getDevices: async () => { throw { status: 503 }; } });
    await failed.controller.refresh();
    expect(failed.controller.state.loaded).toBe(false);
    expect(failed.controller.state.error).toBeTruthy();
    expect(failed.controller.state.snapshot).toBeNull();
  });

  it('401清空当前账号的所有设备和快照', async () => {
    const { controller, api, token } = fixture();
    await controller.refresh();
    api.getDevices = async () => { throw { status: 401 }; };
    await controller.refresh();
    expect(controller.state).toMatchObject({ signedIn: false, devices: [], snapshot: null, selectedId: '' });
    expect(token()).toBe('');
  });

  it('退出后迟到的数据响应不能恢复旧账号内容', async () => {
    let finish!: (value: DeviceSnapshot) => void;
    const { controller } = fixture({ getSnapshot: () => new Promise(resolve => { finish = resolve; }) });
    const pending = controller.refresh();
    await Promise.resolve();
    controller.logout();
    finish(snapshot);
    await pending;
    expect(controller.state).toMatchObject({ signedIn: false, snapshot: null, devices: [], selectedId: '' });
  });

  it('退出后迟到的登录响应不能保存新token', async () => {
    let finish!: (value: { token: string }) => void;
    const { controller, token } = fixture({ login: () => new Promise(resolve => { finish = resolve; }) });
    controller.logout();
    const pending = controller.login('13800000000', '123456');
    controller.logout();
    finish({ token: 'late-login-token' });
    await pending;
    expect(token()).toBe('');
    expect(controller.state.signedIn).toBe(false);
  });

  it('切换设备时清掉旧值，较早的响应不能覆盖最新选择', async () => {
    const other = { ...device, publicId: 'dev_b' };
    const first = fixture({ getDevices: async () => [device, other] });
    await first.controller.refresh();
    let oldFinish!: (value: DeviceSnapshot) => void;
    first.api.getSnapshot = id => id === 'dev_a' ? new Promise(resolve => { oldFinish = resolve; }) : Promise.resolve({ ...snapshot, brightnessLevel: 2 });
    const old = first.controller.selectDevice('dev_a');
    expect(first.controller.state.snapshot).toBeNull();
    await first.controller.selectDevice('dev_b');
    oldFinish(snapshot);
    await old;
    expect(first.controller.state.selectedId).toBe('dev_b');
    expect(first.controller.state.snapshot?.brightnessLevel).toBe(2);
  });

  it('短信限流保留服务端等待秒数并阻止立即重发', async () => {
    const sendCode = vi.fn(async () => { throw { status: 429, retryAfterSeconds: 90 }; });
    const { controller } = fixture({ sendCode });
    controller.logout();
    await controller.sendCode('13800000000');
    expect(controller.state.retryAt).toBeGreaterThan(Date.now() + 85_000);
    await controller.sendCode('13800000000');
    expect(sendCode).toHaveBeenCalledTimes(1);
  });

  it('验证码错误提示验证码问题，且保留已发送短信的冷却时间', async () => {
    const { controller } = fixture({ login: async () => { throw { status: 401, payload: { error: 'code_invalid' } }; } });
    controller.logout();
    await controller.sendCode('13800000000');
    const retryAt = controller.state.retryAt;
    await controller.login('13800000000', '000000');
    expect(controller.state.signedIn).toBe(false);
    expect(controller.state.error).toContain('验证码');
    expect(controller.state.error).not.toContain('登录已过期');
    expect(controller.state.retryAt).toBe(retryAt);
  });
});

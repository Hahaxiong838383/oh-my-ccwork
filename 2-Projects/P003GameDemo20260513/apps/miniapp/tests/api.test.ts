import { beforeEach, describe, expect, it, vi } from 'vitest';
import Taro from '@tarojs/taro';
import { apiRequest, saveSession } from '../src/services/api';
import { liveApi } from '../src/services/live-api';

const storage = new Map<string, string>();
vi.mock('@tarojs/taro', () => ({ default: {
  getStorageSync: vi.fn((key: string) => storage.get(key) || ''),
  setStorageSync: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeStorageSync: vi.fn((key: string) => storage.delete(key)),
  request: vi.fn(),
} }));

beforeEach(() => {
  storage.clear();
  vi.mocked(Taro.request).mockReset();
  process.env.TARO_APP_API_BASE_URL = 'https://test.example';
});

describe('小可现有后台合同适配', () => {
  it('短信登录使用现成路径和验证码字段，不把旧会话传给登录接口', async () => {
    saveSession('old-account');
    vi.mocked(Taro.request).mockResolvedValueOnce({ statusCode: 200, header: {}, data: { ok: true } } as never)
      .mockResolvedValueOnce({ statusCode: 200, header: {}, data: { ok: true, token: 'new-account', account: { id: 'acct-b', nickname: '' }, is_new: false } } as never);
    await liveApi.sendCode('13800000000');
    expect(await liveApi.login('13800000000', '123456')).toEqual({ token: 'new-account' });
    expect(vi.mocked(Taro.request).mock.calls.map(([request]) => ({ url: request.url, method: request.method, data: request.data, authorization: request.header?.Authorization }))).toEqual([
      { url: 'https://test.example/api/auth/sms/send', method: 'POST', data: { phone: '13800000000' }, authorization: undefined },
      { url: 'https://test.example/api/auth/sms/verify', method: 'POST', data: { phone: '13800000000', code: '123456' }, authorization: undefined },
    ]);
  });

  it('按服务端public_id读取快照，正确转换snake_case并保留0/false/null', async () => {
    vi.mocked(Taro.request).mockResolvedValueOnce({ statusCode: 200, header: {}, data: { ok: true, devices: [{ sn: 'SN-A', public_id: 'dev_a', note: '读写台', status: 'active', brain_opened: true }] } } as never)
      .mockResolvedValueOnce({ statusCode: 200, header: {}, data: { ok: true, data: { device: { online: false, updated_at_ms: 1793260800000, present: false, brightness_level: 0, image_distance_m: null, image_distance_state: null }, today: { focus_minutes: 0 }, week: {} } } } as never);
    const devices = await liveApi.getDevices();
    expect(devices).toEqual([{ sn: 'SN-A', publicId: 'dev_a', note: '读写台', status: 'active', brainOpened: true }]);
    expect(await liveApi.getSnapshot(devices[0].publicId)).toEqual({ online: false, updatedAtMs: 1793260800000, present: false, brightnessLevel: 0, imageDistanceM: null, imageDistanceState: null });
    expect(vi.mocked(Taro.request).mock.calls[1][0].url).toBe('https://test.example/v1/parent/devices/dev_a/dashboard');
  });

  it('200但缺少devices时报告合同错误，不伪装为空列表', async () => {
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { ok: true, data: [] } } as never);
    await expect(liveApi.getDevices()).rejects.toMatchObject({ status: 502 });
  });

  it('200但缺少设备快照结构时报告合同错误', async () => {
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { ok: true, data: { device: {} } } } as never);
    await expect(liveApi.getSnapshot('dev_a')).rejects.toMatchObject({ status: 502 });
  });
});

describe('真实接口请求与账号隔离', () => {
  it('微信公开配置不带旧token也不读取用户标识，缺Secret保持未就绪',async()=>{
    saveSession('old-account');
    vi.mocked(Taro.request).mockResolvedValueOnce({statusCode:200,header:{},data:{ok:true,app_id:'wx-test',configured:false,configuration_status:'missing_app_secret'}} as never);
    expect(await liveApi.getWechatConfiguration!()).toEqual({appId:'wx-test',configured:false,configurationStatus:'missing_app_secret'});
    expect(vi.mocked(Taro.request).mock.calls[0][0].header?.Authorization).toBeUndefined();
  });
  it('微信补齐 code 过期不会清除已登录短信账号，真实认证过期仍清除', async () => {
    saveSession('account-a');
    vi.mocked(Taro.request).mockResolvedValueOnce({ statusCode:401,header:{},data:{error:'wechat_login_code_invalid'} } as never);
    await expect(liveApi.linkWechat!({phone_code:'p',login_code:'l',app_id:'wx-test'})).rejects.toMatchObject({status:401});
    expect(storage.get('xiaoke.bff.session')).toBe('account-a');
    vi.mocked(Taro.request).mockResolvedValueOnce({ statusCode:401,header:{},data:{error:'unauthorized'} } as never);
    await expect(liveApi.linkWechat!({phone_code:'p',login_code:'l',app_id:'wx-test'})).rejects.toMatchObject({status:401});
    expect(storage.get('xiaoke.bff.session')).toBeUndefined();
  });
  it('微信登录只发送临时授权码和运行 AppID，保存后端核验身份',async()=>{
    saveSession('old-account');
    vi.mocked(Taro.request).mockResolvedValueOnce({statusCode:200,header:{},data:{ok:true,token:'new-account',wechat_identity:{app_id:'wx-test',configured:true,state:'linked',openid:'verified-openid',unionid:null,unionid_status:'not_returned',verified_at_ms:1793933632128}}} as never);
    const result=await liveApi.loginWechat!({phone_code:'phone',login_code:'login',app_id:'wx-test'});
    expect(result.wechatIdentity).toMatchObject({appId:'wx-test',openid:'verified-openid',unionid:null,unionidStatus:'not_returned'});
    expect(vi.mocked(Taro.request).mock.calls[0][0]).toMatchObject({url:'https://test.example/api/auth/wechat/phone',data:{phone_code:'phone',login_code:'login',app_id:'wx-test'}});
    expect(vi.mocked(Taro.request).mock.calls[0][0].header?.Authorization).toBeUndefined();
  });
  it('发送当前会话并保留真实零值和未知值', async () => {
    saveSession('account-a');
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: {}, data: { brightness_level: 0, present: false, updated_at_ms: null } } as never);
    expect(await apiRequest('/api/profile/bound-devices')).toEqual({ brightnessLevel: 0, present: false, updatedAtMs: null });
    expect(vi.mocked(Taro.request).mock.calls[0][0]).toMatchObject({
      url: 'https://test.example/api/profile/bound-devices', header: { Authorization: 'Bearer account-a' },
    });
  });

  it('当前会话401后清除登录态', async () => {
    saveSession('account-a');
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 401, header: {}, data: { error: 'unauthorized' } } as never);
    await expect(apiRequest('/api/profile/bound-devices')).rejects.toMatchObject({ status: 401 });
    expect(storage.get('xiaoke.bff.session')).toBeUndefined();
  });

  it('静态站点兜底HTML的200不能当作业务接口成功', async () => {
    vi.mocked(Taro.request).mockResolvedValue({ statusCode: 200, header: { 'content-type': 'text/html' }, data: '<!doctype html><html></html>' } as never);
    await expect(apiRequest('/api/profile/bound-devices')).rejects.toMatchObject({ status: 502 });
  });

  it('A的迟到401不能清除后来登录的B会话', async () => {
    let finish!: (value: unknown) => void;
    saveSession('account-a');
    vi.mocked(Taro.request).mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
    const pending = apiRequest('/api/profile/bound-devices');
    saveSession('account-b');
    finish({ statusCode: 401, header: {}, data: {} });
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(storage.get('xiaoke.bff.session')).toBe('account-b');
  });
});

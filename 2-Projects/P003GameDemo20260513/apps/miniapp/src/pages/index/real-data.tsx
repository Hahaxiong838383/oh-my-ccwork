import { useEffect, useState } from 'react';
import Taro from '@tarojs/taro';
import { Button, Text, View } from '@tarojs/components';
import { liveApi } from '../../services/live-api';
import { LiveDataController, snapshotView } from '../../services/live-data';
import { Card, Empty, Field, Heading, Primary } from './components';
import RealDetails from './real-details';

export default function RealDataHome() {
  const [controller] = useState(() => new LiveDataController(liveApi));
  const [state, setState] = useState(controller.state);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.refresh();
    if (process.env.TARO_ENV === 'weapp') { void Taro.setNavigationBarTitle({ title: '小可 · 我的设备' }); void controller.loadWechatConfiguration(); }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [controller]);

  const waitSeconds = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const currentDevice = state.devices.find(item => item.publicId === state.selectedId);
  const view = snapshotView(state.snapshot);
  const logout = () => { controller.logout(); setPhone(''); setCode(''); };
  const authorizeWechat = (event: { detail: { code?: string } }) => void controller.authorizeWechat(async () => {
    if (process.env.TARO_ENV !== 'weapp') throw { code: 'wechat_platform_unavailable' };
    if (!event.detail.code) throw { code: 'wechat_cancelled' };
    const appId = Taro.getAccountInfoSync().miniProgram.appId;
    const login = await Taro.login();
    if (!appId || !login.code) throw { code: 'wechat_login_code_invalid' };
    return { phone_code: event.detail.code, login_code: login.code, app_id: appId };
  });

  return <View className={`app-screen home-screen live-screen ${process.env.TARO_ENV === 'weapp' ? 'weapp-screen' : ''}`}>
    <View className="preview-strip"><Text>内测 · 真实设备数据</Text><Text>小可</Text></View>
    <View className="app-header"><Text className="app-title">我的读写台</Text>{state.signedIn && <Button className="link-button" onClick={logout}>退出登录</Button>}</View>
    <View className="tab-content">
      {!state.signedIn && <Card>
        <Heading title="登录内测账号" />
        <Text className="muted live-description">登录后查看属于当前账号的设备。</Text>
        {process.env.TARO_ENV === 'weapp' && <><Button className="action-button primary" openType="getPhoneNumber" onGetPhoneNumber={authorizeWechat} loading={state.wechatBusy} disabled={state.busy || state.wechatBusy || state.sendingCode || !state.wechatConfiguration?.configured}>微信手机号授权登录</Button><Text className="small-note">{state.wechatConfiguration?.configured?'使用微信授权手机号登录，同时关联微信身份。也可使用下方短信登录。':state.wechatConfiguration?'微信登录凭据待配置，请先使用短信登录。':'正在确认微信登录配置…'}</Text>{!state.wechatConfiguration&&<Button className="link-button" onClick={()=>void controller.loadWechatConfiguration()}>重新读取微信配置</Button>}</>}
        <Field label="手机号" value={phone} onChange={setPhone} numeric maxLength={11} placeholder="请输入手机号" />
        <View className="live-code-row">
          <Field label="验证码" value={code} onChange={setCode} numeric maxLength={6} placeholder="6位短信验证码" />
          <Button className="live-code-button" disabled={state.sendingCode || state.busy || waitSeconds > 0} onClick={() => void controller.sendCode(phone)}>{state.sendingCode ? '发送中' : waitSeconds > 0 ? `${waitSeconds}秒后重发` : '获取验证码'}</Button>
        </View>
        <Primary disabled={state.busy || state.wechatBusy || state.sendingCode || !/^1\d{10}$/.test(phone) || !/^\d{6}$/.test(code)} onClick={() => void controller.login(phone, code)}>{state.busy ? '正在登录…' : '短信登录'}</Primary>
        {state.message && <Text className="small-note">{state.message}</Text>}
      </Card>}

      {state.error && <View className="notice live-error"><Text>{state.error}</Text>{state.signedIn && <Button className="link-button" onClick={() => void controller.refresh()}>重新加载</Button>}</View>}
      {state.wechatError && <View className="notice live-error"><Text>{state.wechatError}</Text></View>}

      {state.signedIn && <>
        <Card><Heading title="微信身份"/><Text className="row-title">{state.wechatIdentity?.state === 'linked' ? '微信身份已验证' : state.wechatIdentity?.state === 'not_configured' ? '微信登录配置待完成' : '尚未关联微信身份'}</Text>
          {state.wechatIdentity?.appId && <Text className="small-note" selectable>小程序 AppID：{state.wechatIdentity.appId}</Text>}
          {state.wechatIdentity?.state === 'linked' && <Text className="small-note">{state.wechatIdentity.unionidStatus === 'available' ? '跨应用身份已返回' : '微信暂未返回 UnionID，不影响当前账号使用'}</Text>}
          {state.wechatIdentity?.configured===false&&<Text className="small-note">服务端微信登录凭据待配置；已有设备数据仍可查看。</Text>}
          {process.env.TARO_ENV === 'weapp' ? <Button className="link-button" openType="getPhoneNumber" onGetPhoneNumber={authorizeWechat} loading={state.wechatBusy} disabled={state.busy || state.wechatBusy || !state.wechatIdentity?.configured}>{state.wechatIdentity?.state === 'linked' ? '重新验证微信身份' : '补充微信身份'}</Button> : <Text className="small-note">请在微信小程序内授权当前账号手机号，补充微信身份。</Text>}
          {state.message && <Text className="small-note">{state.message}</Text>}
        </Card>
        <View className="section-heading"><Text className="section-title">我的设备</Text><Button className="link-button" disabled={state.busy || state.wechatBusy} onClick={() => void controller.refresh()}>{state.busy ? '正在读取…' : '刷新'}</Button></View>
        {!state.loaded && state.busy && <Card><Text className="muted">正在读取设备列表…</Text></Card>}
        {state.loaded && !state.devices.length && <Card><Empty title="当前账号暂无设备" text="请联系内测负责人确认设备归属，再刷新列表。" action="刷新设备" onClick={() => void controller.refresh()} /></Card>}
        {state.devices.length > 0 && <Card className="live-device-list">
          {state.devices.map(device => <Button key={device.publicId} disabled={state.wechatBusy} className={`live-device-row ${state.selectedId === device.publicId ? 'selected' : ''}`} onClick={() => void controller.selectDevice(device.publicId)}>
            <View><Text className="row-title">{device.note || '读写台'}</Text><Text className="small-note">设备尾号 {device.sn.slice(-6)}{device.status === 'disabled' ? ' · 已停用' : ''}</Text></View>
            <Text className="live-selected">{state.selectedId === device.publicId ? '已选择' : '查看'}</Text>
          </Button>)}
        </Card>}
        {currentDevice && <Card>
          <Heading title="设备上报状态" />
          {state.busy ? <Text className="muted">正在读取设备数据…</Text> : state.snapshot ? <>
            <Text className={`device-state ${view.availability !== 'available' ? 'offline' : ''}`}>{view.onlineText}</Text>
            <Text className="small-note">按最近10分钟上报判断，不代表实时网络状态。</Text>
            {view.availability === 'no_data' ? <Text className="paragraph muted">尚未收到这台设备的状态上报，请确认设备已联网后刷新。</Text> : <>
              {view.availability === 'stale' && <Text className="notice">近期未收到上报，以下为上次记录。</Text>}
              <View className="live-metrics">
                <View><Text className="metric-label">亮度</Text><Text className="live-metric-value">{view.brightness}</Text></View>
                <View><Text className="metric-label">灯光</Text><Text className="live-metric-value">{view.lighting}</Text></View>
                <View><Text className="metric-label">色温</Text><Text className="live-metric-value">{view.colorMode}</Text></View>
                <View><Text className="metric-label">使用计时</Text><Text className="live-metric-value">{view.focus}</Text></View>
                <View><Text className="metric-label">在位状态</Text><Text className="live-metric-value">{view.presence}</Text></View>
                <View><Text className="metric-label">视距</Text><Text className="live-metric-value">{view.distance}</Text></View>
              </View>
              <Text className="small-note">最近上报：{new Date(state.snapshot.updatedAtMs!).toLocaleString()}</Text>
            </>}
          </> : !state.error && <Text className="muted">暂无设备数据</Text>}
        </Card>}
        {currentDevice && !state.busy && state.snapshot && <RealDetails key={state.selectedId} publicId={state.selectedId} details={state.snapshot.details} onAccessLost={status=>{if(status===401)logout();else void controller.refresh();}}/>}
      </>}
    </View>
  </View>;
}

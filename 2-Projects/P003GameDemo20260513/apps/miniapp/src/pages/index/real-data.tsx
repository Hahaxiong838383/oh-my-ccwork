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
    if (process.env.TARO_ENV === 'weapp') void Taro.setNavigationBarTitle({ title: '小可 · 我的设备' });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [controller]);

  const waitSeconds = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const currentDevice = state.devices.find(item => item.publicId === state.selectedId);
  const view = snapshotView(state.snapshot);
  const logout = () => { controller.logout(); setPhone(''); setCode(''); };

  return <View className={`app-screen home-screen live-screen ${process.env.TARO_ENV === 'weapp' ? 'weapp-screen' : ''}`}>
    <View className="preview-strip"><Text>内测 · 真实设备数据</Text><Text>小可</Text></View>
    <View className="app-header"><Text className="app-title">我的读写台</Text>{state.signedIn && <Button className="link-button" onClick={logout}>退出登录</Button>}</View>
    <View className="tab-content">
      {!state.signedIn && <Card>
        <Heading title="登录内测账号" />
        <Text className="muted live-description">使用短信验证码登录后，查看属于当前账号的设备。</Text>
        <Field label="手机号" value={phone} onChange={setPhone} numeric maxLength={11} placeholder="请输入手机号" />
        <View className="live-code-row">
          <Field label="验证码" value={code} onChange={setCode} numeric maxLength={6} placeholder="6位短信验证码" />
          <Button className="live-code-button" disabled={state.sendingCode || state.busy || waitSeconds > 0} onClick={() => void controller.sendCode(phone)}>{state.sendingCode ? '发送中' : waitSeconds > 0 ? `${waitSeconds}秒后重发` : '获取验证码'}</Button>
        </View>
        <Primary disabled={state.busy || state.sendingCode || !/^1\d{10}$/.test(phone) || !/^\d{6}$/.test(code)} onClick={() => void controller.login(phone, code)}>{state.busy ? '正在登录…' : '登录'}</Primary>
        {state.message && <Text className="small-note">{state.message}</Text>}
      </Card>}

      {state.error && <View className="notice live-error"><Text>{state.error}</Text>{state.signedIn && <Button className="link-button" onClick={() => void controller.refresh()}>重新加载</Button>}</View>}

      {state.signedIn && <>
        <View className="section-heading"><Text className="section-title">我的设备</Text><Button className="link-button" disabled={state.busy} onClick={() => void controller.refresh()}>{state.busy ? '正在读取…' : '刷新'}</Button></View>
        {!state.loaded && state.busy && <Card><Text className="muted">正在读取设备列表…</Text></Card>}
        {state.loaded && !state.devices.length && <Card><Empty title="当前账号暂无设备" text="请联系内测负责人确认设备归属，再刷新列表。" action="刷新设备" onClick={() => void controller.refresh()} /></Card>}
        {state.devices.length > 0 && <Card className="live-device-list">
          {state.devices.map(device => <Button key={device.publicId} className={`live-device-row ${state.selectedId === device.publicId ? 'selected' : ''}`} onClick={() => void controller.selectDevice(device.publicId)}>
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

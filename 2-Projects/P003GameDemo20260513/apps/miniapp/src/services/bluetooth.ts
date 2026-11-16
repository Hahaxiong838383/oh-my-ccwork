import Taro from '@tarojs/taro';

export type NearbyDevice = { id: string; name: string };
export type ConnectionCheck = { name: string; disconnect: () => Promise<void> };
type AdvertisedDevice = { deviceId: string; localName?: string; name?: string };

export function filterReaderDevices(devices: AdvertisedDevice[]): NearbyDevice[] {
  const seen = new Set<string>();
  return devices.flatMap(device => {
    const name = device.localName || device.name || '';
    if (!device.deviceId || seen.has(device.deviceId) || !/^EyesCare (Max|Ultra)-.+/.test(name)) return [];
    seen.add(device.deviceId);
    return [{ id: device.deviceId, name }];
  });
}
interface BrowserDevice {
  name?: string;
  gatt?: { connected: boolean; connect(): Promise<unknown>; disconnect(): void };
}
interface WebBluetooth {
  requestDevice(options: { acceptAllDevices: true }): Promise<BrowserDevice>;
}

export function browserCapability(secure: boolean, hasBluetooth: boolean) {
  if (!secure) return { supported: false, message: '蓝牙检查需要 HTTPS 或本机开发地址' };
  if (!hasBluetooth) return { supported: false, message: '当前系统浏览器不支持网页蓝牙，需验证其他配网路径' };
  return { supported: true, message: '浏览器提供蓝牙接口，可由你选择设备进行连接检查' };
}

export function bluetoothCapability() {
  if (process.env.TARO_ENV === 'weapp') return { supported: true, message: '可使用微信蓝牙接口；实际权限与硬件连接仍需真机检查' };
  return browserCapability(globalThis.isSecureContext, typeof navigator !== 'undefined' && 'bluetooth' in navigator);
}

export async function scanWechatDevices(): Promise<NearbyDevice[]> {
  if (process.env.TARO_ENV !== 'weapp') return [];
  await Taro.openBluetoothAdapter();
  const found: AdvertisedDevice[] = [];
  const onFound = ({ devices }: { devices: AdvertisedDevice[] }) => { found.push(...devices); };
  Taro.onBluetoothDeviceFound(onFound);
  try {
    await Taro.startBluetoothDevicesDiscovery({ allowDuplicatesKey: false });
    await new Promise(resolve => setTimeout(resolve, 5000));
    return filterReaderDevices(found);
  } catch (error) {
    await Taro.stopBluetoothDevicesDiscovery().catch(() => undefined);
    throw error;
  } finally {
    Taro.offBluetoothDeviceFound(onFound);
  }
}

export async function checkConnection(device?: NearbyDevice): Promise<ConnectionCheck> {
  if (process.env.TARO_ENV === 'weapp') {
    if (!device) throw new Error('请选择附近设备');
    await Taro.createBLEConnection({ deviceId: device.id, timeout: 10000 });
    return { name: device.name, disconnect: async () => { await Taro.closeBLEConnection({ deviceId: device.id }); } };
  }
  const capability = bluetoothCapability();
  if (!capability.supported) throw new Error(capability.message);
  const bluetooth = (navigator as unknown as { bluetooth: WebBluetooth }).bluetooth;
  // UUID与设备签名协议尚未冻结：这里只做用户选择后的GATT连接，不写入Wi-Fi或认定绑定成功。
  const chosen = await bluetooth.requestDevice({ acceptAllDevices: true });
  if (!chosen.gatt) throw new Error('选中的设备不提供 BLE GATT 服务');
  await chosen.gatt.connect();
  return { name: chosen.name || '已选设备', disconnect: async () => chosen.gatt?.disconnect() };
}

export async function releaseBluetooth() {
  if (process.env.TARO_ENV === 'weapp') {
    await Taro.stopBluetoothDevicesDiscovery().catch(() => undefined);
    await Taro.closeBluetoothAdapter().catch(() => undefined);
  }
}

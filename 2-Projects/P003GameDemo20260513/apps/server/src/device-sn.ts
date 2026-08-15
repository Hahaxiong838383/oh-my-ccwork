/**
 * P003 MCU 设备 SN 校验（S2B1 合同：CC_P003_MCU_DEVICE_SN_CONTRACT_20260815）。
 *
 * 规则：BJP003 + YYMMDD + NNNNNNNN，固定 20 位大写 ASCII。
 * - 正则初筛 ^BJP003[0-9]{14}$（协议无效值 BJ000000000000000000 天然不过初筛）
 * - YYMMDD 必须是真实日历日期（20YY 年；2 月 31 日这类直接拒绝）
 * - 8 位流水号 00000000 禁用
 *
 * 纯函数零依赖——单测直接调它，不在测试里重写一遍判据。
 */
export type SnCheck = { ok: true } | { ok: false; reason: string };

export function validateDeviceSn(sn: unknown): SnCheck {
  if (typeof sn !== 'string') return { ok: false, reason: 'device_sn 必须是字符串' };
  if (!/^BJP003[0-9]{14}$/.test(sn)) {
    return { ok: false, reason: 'device_sn 格式不符（BJP003 + 14 位数字，共 20 位）' };
  }
  const yy = Number(sn.slice(6, 8));
  const mm = Number(sn.slice(8, 10));
  const dd = Number(sn.slice(10, 12));
  // 用 UTC 构造后回读三段：任一段被 Date 归一化挪动过（如 02-31 → 03-03）即非真实日期。
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  if (
    d.getUTCFullYear() !== 2000 + yy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) {
    return { ok: false, reason: `YYMMDD 不是真实日期: ${sn.slice(6, 12)}` };
  }
  if (sn.slice(12) === '00000000') {
    return { ok: false, reason: '流水号 00000000 禁用' };
  }
  return { ok: true };
}

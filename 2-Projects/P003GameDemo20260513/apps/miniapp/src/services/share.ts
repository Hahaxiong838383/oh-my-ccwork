export type ShareCardData = { kind: 'week' | 'idea'; name: string; title: string; caption: string; period: string; image: string; qr: string; brand: string; quote: string; stamp: string; metrics: { label: string; value: string }[] };
export async function exportShareCard(_data: ShareCardData, _share: boolean): Promise<string | void> {
  throw new Error('当前平台尚未接入图片导出');
}

import Taro from '@tarojs/taro';
import type { ShareCardData } from './share';

function wrapLines(ctx: ReturnType<typeof Taro.createCanvasContext>, text: string, maxWidth: number, maxLines: number) {
  const lines: string[] = [];
  let line = '';
  for (const character of text) {
    if (line && ctx.measureText(`${line}${character}`).width > maxWidth) { lines.push(line); line = character; }
    else line += character;
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  let last = visible[maxLines - 1];
  while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
  visible[maxLines - 1] = `${last}…`;
  return visible;
}

export async function exportShareCard(data: ShareCardData, share: boolean): Promise<void> {
  const [image, qr, brand, quote, stamp] = await Promise.all([
    Taro.getImageInfo({ src: data.image }),
    Taro.getImageInfo({ src: data.qr }),
    Taro.getImageInfo({ src: data.brand }),
    Taro.getImageInfo({ src: data.quote }),
    Taro.getImageInfo({ src: data.stamp }),
  ]);
  const ctx = Taro.createCanvasContext('share-card');
  ctx.setFillStyle('#fff0d8'); ctx.fillRect(0, 0, 320, 550);
  ctx.drawImage(brand.path, 16, 14, 78, 37);
  ctx.drawImage(image.path, 75, 60, 170, 170);
  ctx.setTextAlign('center');
  if (data.kind === 'idea') {
    ctx.setFillStyle('#273237'); ctx.setFontSize(16); ctx.fillText(data.title, 160, 210);
  }
  ctx.setFillStyle('#943900'); ctx.setFontSize(12); ctx.fillText(data.period, 160, data.kind === 'idea' ? 232 : 225);
  ctx.setFillStyle('#fffdf1'); ctx.fillRect(12, 244, 296, 170);
  ctx.drawImage(quote.path, 24, 222, 49, 41);
  ctx.setTextAlign('left'); ctx.setFillStyle('#273237'); ctx.setFontSize(10);
  wrapLines(ctx, data.caption, 270, 3).forEach((text, index) => ctx.fillText(text, 25, 274 + index * 18));
  data.metrics.forEach((metric, i) => {
    const x = 55 + i * (210 / Math.max(data.metrics.length - 1, 1));
    ctx.setTextAlign('center'); ctx.setFillStyle('#FF8136'); ctx.setFontSize(14); ctx.fillText(metric.value, x, 365);
    ctx.setFillStyle('#9aa2a0'); ctx.setFontSize(9); ctx.fillText(metric.label, x, 383);
  });
  ctx.setFillStyle('#ffffff'); ctx.fillRect(12, 425, 296, 87);
  ctx.drawImage(qr.path, 24, 439, 60, 60);
  ctx.drawImage(stamp.path, 246, 438, 54, 54);
  ctx.setTextAlign('left'); ctx.setFillStyle('#273237'); ctx.setFontSize(9);
  ctx.fillText('也想要个会主动护眼，还不用催的小孩儿？', 94, 450);
  ctx.setFillStyle('#777777');
  ctx.fillText('扫码看看，爱视可空间光学护眼读写台，', 94, 466);
  ctx.fillText('它替你保护孩子的坐姿和视力', 94, 482);
  await new Promise<void>(resolve => ctx.draw(false, resolve));
  const result = await Taro.canvasToTempFilePath({ canvasId: 'share-card', width: 320, height: 550, destWidth: 640, destHeight: 1100 });
  if (share) { await Taro.showShareImageMenu({ path: result.tempFilePath }); return; }
  await Taro.saveImageToPhotosAlbum({ filePath: result.tempFilePath });
  Taro.showToast({ title: '图片已保存', icon: 'success' });
}

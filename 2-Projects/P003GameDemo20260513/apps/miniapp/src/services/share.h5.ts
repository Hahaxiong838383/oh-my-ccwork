import type { ShareCardData } from './share';

async function loadImage(src: string) {
  const image = new Image(); image.src = src; await image.decode(); return image;
}
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) {
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

export async function exportShareCard(data: ShareCardData, share: boolean): Promise<string | void> {
  const canvas = document.createElement('canvas');
  canvas.width = 640; canvas.height = 1100;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('浏览器无法生成图片');
  const [badge, qr, brand, quote, stamp] = await Promise.all([
    loadImage(data.image), loadImage(data.qr), loadImage(data.brand), loadImage(data.quote), loadImage(data.stamp),
  ]);
  const background = ctx.createLinearGradient(0, 0, 0, 1100);
  background.addColorStop(0, '#fff4e1'); background.addColorStop(1, '#ffdcac');
  ctx.fillStyle = background; ctx.fillRect(0, 0, 640, 1100);
  ctx.drawImage(brand, 32, 28, 156, 74);
  ctx.drawImage(badge, 150, 120, 340, 340);
  ctx.textAlign = 'center';
  if (data.kind === 'idea') {
    ctx.fillStyle = '#273237'; ctx.font = 'bold 32px sans-serif'; ctx.fillText(data.title, 320, 420);
  }
  ctx.fillStyle = '#943900'; ctx.font = 'bold 24px sans-serif'; ctx.fillText(data.period, 320, data.kind === 'idea' ? 456 : 450);
  ctx.fillStyle = '#fffdf1'; ctx.fillRect(24, 488, 592, 340);
  ctx.drawImage(quote, 48, 450, 98, 82);
  ctx.textAlign = 'left'; ctx.fillStyle = '#273237'; ctx.font = '24px sans-serif';
  wrapLines(ctx, data.caption, 540, 3).forEach((text, index) => ctx.fillText(text, 50, 548 + index * 36));
  data.metrics.forEach((metric, i) => {
    const x = 120 + i * 200;
    ctx.textAlign = 'center'; ctx.fillStyle = '#FF8136'; ctx.font = 'bold 38px sans-serif'; ctx.fillText(metric.value, x, 702);
    ctx.fillStyle = '#9aa2a0'; ctx.font = '20px sans-serif'; ctx.fillText(metric.label, x, 744);
  });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(24, 850, 592, 174);
  ctx.drawImage(qr, 48, 878, 120, 120);
  ctx.drawImage(stamp, 492, 876, 108, 108);
  ctx.textAlign = 'left'; ctx.fillStyle = '#273237'; ctx.font = '24px sans-serif';
  ctx.fillText('也想要个会主动护眼，还不用催的小孩儿？', 196, 900);
  ctx.fillStyle = '#777777'; ctx.font = '18px sans-serif';
  ctx.fillText('扫码看看，爱视可空间光学护眼读写台，', 196, 932);
  ctx.fillText('它替你保护孩子的坐姿和视力', 196, 964);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片生成失败')), 'image/png'));
  const file = new File([blob], '小可分享卡.png', { type: 'image/png' });
  if (share) {
    if (!navigator.canShare?.({ files: [file] })) throw new Error('浏览器不支持图片分享，请先保存图片后自行分享');
    await navigator.share({ files: [file], title: data.title });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = file.name;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return canvas.toDataURL('image/png');
}

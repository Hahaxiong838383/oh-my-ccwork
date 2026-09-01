#!/usr/bin/env python3
"""把 HTML 里所有 assets/ 图片压缩(~1400px, jpeg q82)后 base64 内嵌, 产出离线单文件。
用法: python3 embed_singlefile.py <input.html> <output.html>
"""
import sys, re, base64, io, os
from PIL import Image

MAX_W = 1400
JPEG_Q = 82
BASE_DIR = "/tmp/narrative_preview"

def compress_to_datauri(rel_path):
    abspath = os.path.join(BASE_DIR, rel_path)
    if not os.path.exists(abspath):
        raise FileNotFoundError(abspath)
    im = Image.open(abspath)
    # 处理透明 png -> 贴深色底(与页面背景 #080b13 一致), 转 RGB 走 jpeg
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (8, 11, 19, 255))
        bg.alpha_composite(im)
        im = bg.convert("RGB")
    else:
        im = im.convert("RGB")
    w, h = im.size
    if w > MAX_W:
        im = im.resize((MAX_W, round(h * MAX_W / w)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=JPEG_Q, optimize=True, progressive=True)
    data = buf.getvalue()
    b64 = base64.b64encode(data).decode()
    return f"data:image/jpeg;base64,{b64}", len(data)

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp, encoding="utf-8") as f:
        html = f.read()

    # 收集所有 assets/ 引用 (src 与 url() 两种)
    refs = set(re.findall(r'(?:src=["\']|url\(["\']?)(assets/[^"\')]+)', html))
    print(f"发现 {len(refs)} 个 assets 引用")
    total_raw = 0
    cache = {}
    for rel in sorted(refs):
        uri, sz = compress_to_datauri(rel)
        cache[rel] = uri
        total_raw += sz
        print(f"  {rel:38s} -> {sz/1024:6.1f} KB")

    # 替换: src="assets/.." / src='assets/..' / url(assets/..) / url('assets/..')
    def repl_src(m):
        q, path = m.group(1), m.group(2)
        return f'src={q}{cache.get(path, path)}{q}' if path in cache else m.group(0)
    html = re.sub(r'src=(["\'])(assets/[^"\']+)\1', repl_src, html)

    def repl_url(m):
        path = m.group(2)
        if path in cache:
            return f'url({m.group(1)}{cache[path]}{m.group(3)})'
        return m.group(0)
    html = re.sub(r'url\((["\']?)(assets/[^"\')]+)(["\']?)\)', repl_url, html)

    with open(outp, "w", encoding="utf-8") as f:
        f.write(html)
    out_sz = os.path.getsize(outp)
    print(f"\n图片原始字节合计 {total_raw/1024/1024:.2f} MB (base64 约 *1.33)")
    print(f"输出单文件 {outp} = {out_sz/1024/1024:.2f} MB")
    # 校验无残留外部引用
    leftover = re.findall(r'(?:src=["\']|url\(["\']?)(assets/[^"\')]+)', html)
    print(f"残留未内嵌 assets 引用: {len(leftover)} {'✓ 干净' if not leftover else leftover}")

if __name__ == "__main__":
    main()

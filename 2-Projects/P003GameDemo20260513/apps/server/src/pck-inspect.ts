import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

/**
 * Godot PCK 实测检查（双 OTA 合同 §3.8 / §7 / CC J0 补充口径）。
 *
 * 只读解析 Godot 4.x PCK（pack format 2；magic "GDPC"）的头与文件表：
 *   u32 magic=0x43504447 · u32 pack_version=2 · u32 major · u32 minor · u32 patch · u32 pack_flags ·
 *   u64 file_base · 16×u32 reserved · u32 file_count · [u32 path_len, path(补零), u64 ofs, u64 size, md5[16], u32 flags]…
 *   文件绝对偏移 = file_base + ofs（4.4 源码 add_path(file_base + ofs + p_offset)）。
 * 真值来源：godot 4.4 core/io/file_access_pack.{h,cpp}（2026-09-04 取证）。
 *
 * 门（任一不过即拒，PCK 本体为真值，不信文件名）：
 *   - 体积 ≤ 32MiB（合同 §2 端侧硬上限，同值）；
 *   - magic/pack_version 正确，目录未加密（加密目录无法审核=拒），文件条目无加密标记；
 *   - 路径不含代码/原生扩展：首期只允许非执行内容（合同 §3.8）；
 *   - 文件表偏移不越界。
 * 顺带：从内嵌 manifest（默认 res://pck/g1_content_manifest.json）抽 required_resources，
 * 供 check 响应「返回不可变 manifest 的完整数组」（合同 §5）；admin 可在草稿期覆盖。
 */

export const PCK_MAGIC = 0x43504447; // "GDPC"
export const PCK_FORMAT_VERSION = 2;
export const PCK_MAX_BYTES = 32 * 1024 * 1024;
export const PCK_FLAG_DIR_ENCRYPTED = 1 << 0;
export const PCK_FLAG_REL_FILEBASE = 1 << 1;
export const PCK_FILE_ENCRYPTED = 1 << 0;
export const PCK_FILE_REMOVAL = 1 << 1;
export const PCK_MANIFEST_PATH_DEFAULT = 'res://pck/g1_content_manifest.json';
/** 首期禁止的扩展（代码 / 原生 / shader）——合同 §3.8 + CC J0 补充口径。 */
export const PCK_FORBIDDEN_EXT = [
  '.gd', '.gdc', '.gde', '.gdextension', '.gdns', '.gdnlib',
  '.so', '.dex', '.apk', '.jar', '.aar', '.dll', '.dylib', '.wasm',
  '.gdshader', '.gdshaderinc', '.shader',
];
const MAX_FILE_COUNT = 200_000;
const MAX_PATH_LEN = 4096;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PATHS_KEPT = 5000;

export type PckEntry = { path: string; ofs: number; size: number; flags: number };

export type PckFacts = {
  size_bytes: number;
  sha256: string;
  pack_version: number;
  godot_version: string;
  pack_flags: number;
  file_count: number;
  /** 前 MAX_PATHS_KEPT 条路径（admin 目视审核用） */
  paths: string[];
  /** 命中禁止扩展的路径（非空即拒） */
  forbidden: string[];
  /** 内嵌 manifest 抽出的 required_resources（无 manifest / 无该键 = []） */
  required_resources: string[];
  manifest_found: boolean;
};

export class PckInspectError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function pckMaxBytes(): number {
  // 仅测试覆盖（生产不设此 env）：合同硬上限 32MiB 不动
  const o = Number(process.env.PCK_MAX_BYTES_OVERRIDE || 0);
  return o > 0 ? o : PCK_MAX_BYTES;
}

export function forbiddenExt(path: string): string | null {
  const lower = path.toLowerCase();
  for (const ext of PCK_FORBIDDEN_EXT) if (lower.endsWith(ext)) return ext;
  return null;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** 顺序读取器：小块读，避免把整包读进内存。 */
class Reader {
  private buf = Buffer.alloc(0);
  private pos = 0; // 文件绝对位置（buf 起点）
  constructor(private readonly fh: Awaited<ReturnType<typeof open>>, private readonly size: number) {}

  async ensure(n: number): Promise<void> {
    if (this.buf.length >= n) return;
    const need = Math.max(n, 64 * 1024);
    const chunk = Buffer.alloc(need - this.buf.length);
    const { bytesRead } = await this.fh.read(chunk, 0, chunk.length, this.pos + this.buf.length);
    this.buf = Buffer.concat([this.buf, chunk.subarray(0, bytesRead)]);
    if (this.buf.length < n) throw new PckInspectError('truncated', `文件表越界（期望 ${n} 字节，位置 ${this.pos}，文件 ${this.size} 字节）`);
  }
  async take(n: number): Promise<Buffer> {
    await this.ensure(n);
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    this.pos += n;
    return out;
  }
  async u32(): Promise<number> { return (await this.take(4)).readUInt32LE(0); }
  async u64(): Promise<number> {
    const b = await this.take(8);
    const v = b.readBigUInt64LE(0);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new PckInspectError('bad_offset', '偏移超出安全整数');
    return Number(v);
  }
}

export async function inspectPck(path: string, manifestPath = process.env.PCK_MANIFEST_PATH?.trim() || PCK_MANIFEST_PATH_DEFAULT): Promise<PckFacts> {
  const st = await stat(path);
  if (st.size > pckMaxBytes()) throw new PckInspectError('too_large', `PCK ${st.size} 字节超过硬上限 ${pckMaxBytes()}`);
  if (st.size < 100) throw new PckInspectError('bad_magic', '文件过小，不是 PCK');
  const fh = await open(path, 'r');
  try {
    const r = new Reader(fh, st.size);
    const magic = await r.u32();
    if (magic !== PCK_MAGIC) throw new PckInspectError('bad_magic', 'magic 不是 GDPC');
    const packVersion = await r.u32();
    if (packVersion !== PCK_FORMAT_VERSION) throw new PckInspectError('pack_version_unsupported', `pack 格式版本 ${packVersion} 不支持（只认 ${PCK_FORMAT_VERSION}）`);
    const major = await r.u32();
    const minor = await r.u32();
    const patch = await r.u32();
    const packFlags = await r.u32();
    const fileBase = await r.u64();
    for (let i = 0; i < 16; i++) await r.u32();
    const fileCount = await r.u32();
    if (packFlags & PCK_FLAG_DIR_ENCRYPTED) throw new PckInspectError('dir_encrypted', '目录已加密，无法审核内容');
    // PCK_FLAG_REL_FILEBASE：独立 .pck 文件 pck_start_pos=0，相对基址等同绝对，无需调整
    if (fileCount > MAX_FILE_COUNT) throw new PckInspectError('too_many_files', `文件数 ${fileCount} 超过 ${MAX_FILE_COUNT}`);

    const paths: string[] = [];
    const forbidden: string[] = [];
    let manifest: PckEntry | null = null;
    for (let i = 0; i < fileCount; i++) {
      const sl = await r.u32();
      if (sl > MAX_PATH_LEN) throw new PckInspectError('bad_path', `路径长度 ${sl} 异常`);
      const raw = await r.take(sl);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      const p = raw.subarray(0, end).toString('utf8');
      const ofs = await r.u64();
      const size = await r.u64();
      await r.take(16); // md5
      const flags = await r.u32();
      if (flags & PCK_FILE_ENCRYPTED) throw new PckInspectError('file_encrypted', `文件已加密：${p}`);
      if (!(flags & PCK_FILE_REMOVAL)) {
        if (fileBase + ofs + size > st.size) throw new PckInspectError('bad_offset', `文件越界：${p}`);
        const bad = forbiddenExt(p);
        if (bad) forbidden.push(p);
        if (p === manifestPath) manifest = { path: p, ofs, size, flags };
      }
      if (paths.length < MAX_PATHS_KEPT) paths.push(p);
    }

    let required: string[] = [];
    let manifestFound = false;
    if (manifest && manifest.size <= MAX_MANIFEST_BYTES) {
      const buf = Buffer.alloc(manifest.size);
      await fh.read(buf, 0, manifest.size, fileBase + manifest.ofs);
      try {
        const j = JSON.parse(buf.toString('utf8')) as { required_resources?: unknown };
        manifestFound = true;
        if (Array.isArray(j.required_resources)) {
          required = j.required_resources.filter((x): x is string => typeof x === 'string' && x.startsWith('res://') && x.length <= 512).slice(0, 500);
        }
      } catch {
        manifestFound = false;
      }
    }

    return {
      size_bytes: st.size,
      sha256: await sha256File(path),
      pack_version: packVersion,
      godot_version: `${major}.${minor}.${patch}`,
      pack_flags: packFlags,
      file_count: fileCount,
      paths,
      forbidden,
      required_resources: required,
      manifest_found: manifestFound,
    };
  } finally {
    await fh.close();
  }
}

/** 造一个最小合法 PCK（pack format 2；测试/探针用，与 Godot PCKPacker 写法同形：路径补零到 4 字节）。 */
export function buildPck(files: Array<{ path: string; data: Buffer }>, opts?: { godot?: [number, number, number]; packFlags?: number; fileFlags?: number }): Buffer {
  const [ma, mi, pa] = opts?.godot ?? [4, 3, 0];
  const entries = files.map((f) => {
    const pb = Buffer.from(f.path, 'utf8');
    const pad = (4 - (pb.length % 4)) % 4;
    return { pathBuf: Buffer.concat([pb, Buffer.alloc(pad)]), data: f.data };
  });
  const headerLen = 4 * 6 + 8 + 16 * 4 + 4;
  const tableLen = entries.reduce((n, e) => n + 4 + e.pathBuf.length + 8 + 8 + 16 + 4, 0);
  const fileBase = headerLen + tableLen;
  const header = Buffer.alloc(headerLen);
  let o = 0;
  const w32 = (v: number) => { header.writeUInt32LE(v >>> 0, o); o += 4; };
  w32(PCK_MAGIC); w32(PCK_FORMAT_VERSION); w32(ma); w32(mi); w32(pa); w32(opts?.packFlags ?? 0);
  header.writeBigUInt64LE(BigInt(fileBase), o); o += 8;
  for (let i = 0; i < 16; i++) w32(0);
  w32(entries.length);
  const table = Buffer.alloc(tableLen);
  let t = 0;
  let dataOfs = 0;
  const datas: Buffer[] = [];
  for (const e of entries) {
    table.writeUInt32LE(e.pathBuf.length, t); t += 4;
    e.pathBuf.copy(table, t); t += e.pathBuf.length;
    table.writeBigUInt64LE(BigInt(dataOfs), t); t += 8;
    table.writeBigUInt64LE(BigInt(e.data.length), t); t += 8;
    createHash('md5').update(e.data).digest().copy(table, t); t += 16;
    table.writeUInt32LE(opts?.fileFlags ?? 0, t); t += 4;
    datas.push(e.data);
    dataOfs += e.data.length;
  }
  return Buffer.concat([header, table, ...datas]);
}

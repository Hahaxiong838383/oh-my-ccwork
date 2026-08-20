import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * APK 实测检查器（OTA 上传校验，codex 冻结修正 2026-08-20）：
 * **APK 实测值才是发布真值**——包名/版本/证书一律从 APK 本体提取，不信任上传者声明
 * （manifest 与 APK 同源提供 = 可同时填错的共模通道）。
 *
 * 依赖系统工具（生产机 apt 安装）：
 *  - aapt dump badging        → package_name / version_code / version_name
 *  - apksigner verify --print-certs → 签名证书 SHA-256 digest（顺带完成签名完整性校验）
 * sha256/size 用 node 流式自算。工具缺失时抛 'apk_tools_missing'（部署检查项）。
 */

export type ApkFacts = {
  package_name: string;
  version_code: number;
  version_name: string;
  cert_sha256: string;
  sha256: string;
  size_bytes: number;
};

export type ApkInspector = (apkPath: string) => Promise<ApkFacts>;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('apk_tools_missing'));
        return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(0, 400)}`));
      }
      resolve(stdout);
    });
  });
}

async function fileSha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function realInspect(apkPath: string): Promise<ApkFacts> {
  const badging = await run('aapt', ['dump', 'badging', apkPath]);
  const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(badging);
  if (!m) throw new Error('aapt badging 解析失败（非法 APK？）');

  const certs = await run('apksigner', ['verify', '--print-certs', apkPath]);
  // apksigner 输出形如：Signer #1 certificate SHA-256 digest: <64hex>
  const cm = /certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(certs);
  if (!cm) throw new Error('apksigner 证书解析失败（签名校验不通过？）');

  const [sha256, st] = await Promise.all([fileSha256(apkPath), stat(apkPath)]);
  return {
    package_name: m[1],
    version_code: Number.parseInt(m[2], 10),
    version_name: m[3],
    cert_sha256: cm[1].toLowerCase(),
    sha256,
    size_bytes: st.size,
  };
}

let inspector: ApkInspector = realInspect;

/** 测试专用：替换实测器（免装 aapt/apksigner）。返回恢复函数。 */
export function setApkInspectorForTest(fn: ApkInspector): () => void {
  const prev = inspector;
  inspector = fn;
  return () => {
    inspector = prev;
  };
}

export function inspectApk(apkPath: string): Promise<ApkFacts> {
  return inspector(apkPath);
}

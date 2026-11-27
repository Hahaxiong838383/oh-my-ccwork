// Official upstream targets modern browsers. Lower syntax for Android's system WebView
// when regenerating a bundle, keeping a normal APK build free of JS toolchain dependencies.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
export function targetWebView(file) {
  const output = execFileSync(process.env.ESBUILD || 'esbuild', [
    '--target=chrome80', '--charset=utf8', '--legal-comments=inline'
  ], {input:readFileSync(file),maxBuffer:8*1024*1024});
  writeFileSync(file,output);
}

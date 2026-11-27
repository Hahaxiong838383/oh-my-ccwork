// Official upstream targets modern browsers. Lower syntax for Android's system WebView
// when regenerating a bundle, keeping a normal APK build free of JS toolchain dependencies.
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
export function targetWebView(file) {
  // Upstream embeds CSS inside template strings and shadow roots. WebView 83
  // drops the inset shorthand and positions those layers after the flat SVG.
  const source = readFileSync(file,'utf8').replace(/position:absolute;inset:0(?=[;}])/g,
    'position:absolute;top:0;right:0;bottom:0;left:0');
  const output = execFileSync(process.env.ESBUILD || 'esbuild', [
    '--target=chrome80', '--charset=utf8', '--legal-comments=inline'
  ], {input:source,maxBuffer:8*1024*1024});
  writeFileSync(file,output);
}

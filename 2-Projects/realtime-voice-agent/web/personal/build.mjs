import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
let html = await readFile(path.join(root, 'index.html'), 'utf8');
for (const name of ['style.css', 'voice.js']) {
  const content = await readFile(path.join(root, name));
  const version = createHash('sha256').update(content).digest('hex').slice(0, 12);
  await writeFile(path.join(out, name), content);
  html = html.replace('./' + name, './' + name + '?v=' + version);
}
await writeFile(path.join(out, 'index.html'), html);
await copyFile(path.join(root, 'node_modules/livekit-client/dist/livekit-client.umd.js'), path.join(out, 'livekit.js'));
await copyFile(path.join(root, 'node_modules/livekit-client/LICENSE'), path.join(out, 'LIVEKIT-LICENSE'));

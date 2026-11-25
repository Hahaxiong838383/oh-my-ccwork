import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'style.css', 'voice.js']) {
  await copyFile(path.join(root, name), path.join(out, name));
}
await copyFile(path.join(root, 'node_modules/livekit-client/dist/livekit-client.umd.js'), path.join(out, 'livekit.js'));
await copyFile(path.join(root, 'node_modules/livekit-client/LICENSE'), path.join(out, 'LIVEKIT-LICENSE'));

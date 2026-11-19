import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from './bridge.js';
import { resolveConfig } from './config.js';
import { consumeJSONLines } from './json-lines.js';
import { createStatusLogger } from './logger.js';

async function main() {
  let config;
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean' } },
      allowPositionals: false, strict: true });
    if (values.help) {
      process.stdout.write('node src/cli.js [--config config.local.json]\nInput: one JSON object per line; {"type":"status"} or {"messageId":"demo.level","value":50}\n');
      return;
    }
    let input = {};
    if (values.config) {
      if ((await stat(values.config)).size > 16384) throw new Error('config_too_large');
      input = JSON.parse(await readFile(values.config, 'utf8'));
    }
    config = resolveConfig(input);
  } catch {
    process.stderr.write('{"event":"startup_error","code":"invalid_configuration"}\n');
    process.exitCode = 1;
    return;
  }
  const log = createStatusLogger({ directory: config.logDirectory });
  const bridge = createBridge(config, log);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true; bridge.stop(); process.stdin.destroy();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  bridge.start();
  const reply = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    await consumeJSONLines(process.stdin, value => {
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          Object.keys(value).length === 1 && value.type === 'status') reply(bridge.status());
      else reply(bridge.send(value));
    }, code => reply({ result: code }));
    if (!closing) {
      log({ event: 'input_closed', protocol: config.protocol });
      // Allow an already submitted transport write to finish; this is not an ACK or replay.
      await delay(100);
    }
  } catch {
    if (!closing) { log({ event: 'input_error', protocol: config.protocol }); process.exitCode = 1; }
  } finally {
    stop(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

await main();

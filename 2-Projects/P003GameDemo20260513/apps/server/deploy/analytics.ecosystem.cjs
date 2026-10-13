const path = require('node:path');
const fs = require('node:fs');
const {parseEnv} = require('node:util');
const cwd = path.resolve(__dirname, '..');
const envFile = process.env.ANALYTICS_ENV_FILE || '/opt/p003/server/.env.analytics';
if (!path.isAbsolute(envFile)) throw new Error('ANALYTICS_ENV_FILE must be absolute');
const protectedRuntime = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile,'utf8')).ANALYTICS_NODE_PATH : undefined;
const nodePath = process.env.ANALYTICS_NODE_PATH || protectedRuntime || '/opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node';
if (!path.isAbsolute(nodePath)) throw new Error('ANALYTICS_NODE_PATH must be absolute');
module.exports = {
  apps: [{
    name: 'p003-analytics', cwd, script: 'deploy/analytics-start.ts',
    interpreter: nodePath, interpreter_args: `--experimental-sqlite --import tsx --env-file=${envFile}`,
    instances: 1, exec_mode: 'fork', max_memory_restart: '512M',
    // Allow the writer's bounded 30s drain before PM2 escalates; HTTP timeouts stay unchanged.
    kill_timeout: 35000, restart_delay: 2000,
    env: { NODE_ENV: 'production' },
  }],
};

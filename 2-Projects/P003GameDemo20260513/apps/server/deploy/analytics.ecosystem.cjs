const path = require('node:path');
const cwd = path.resolve(__dirname, '..');
const envFile = process.env.ANALYTICS_ENV_FILE || '/opt/p003/server/.env.analytics';
if (!path.isAbsolute(envFile)) throw new Error('ANALYTICS_ENV_FILE must be absolute');
module.exports = {
  apps: [{
    name: 'p003-analytics', cwd, script: 'src/analytics/index.ts',
    interpreter: 'node', interpreter_args: `--experimental-sqlite --import tsx --env-file=${envFile}`,
    instances: 1, exec_mode: 'fork', max_memory_restart: '512M',
    kill_timeout: 5000, restart_delay: 2000,
    env: { NODE_ENV: 'production' },
  }],
};

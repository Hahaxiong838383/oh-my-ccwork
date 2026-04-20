// pm2 ecosystem — mycc-brain + 视觉链路一键启动
// 用法:
//   export PATH=/usr/local/bin:$PATH && cd ~/mycc-brain
//   npx pm2 start ecosystem.config.cjs   # 首次启动
//   npx pm2 resurrect                    # 断电/重启后恢复
//   npx pm2 save                         # 保存当前状态（启动后立即运行一次）
//
// 注意：vision-daemon 需要摄像头权限，由 LaunchAgent 管理（不在本文件中）
//   LaunchAgent plist: ~/Library/LaunchAgents/com.mycc.brain.vision-daemon.plist
//   首次部署：见 tools/vision/setup_studio.sh

const BRAIN_ROOT = '/Users/fu-121/mycc-brain';
const VENV_PYTHON = `${BRAIN_ROOT}/tools/vision/.venv-vision/bin/python3.12`;
const DATA_ACTIVITY = `${BRAIN_ROOT}/data/activity`;

module.exports = {
  apps: [
    // ── 1. brain 主服务 ───────────────────────────────────────
    {
      name: 'brain',
      script: 'dist/server.js',
      cwd: BRAIN_ROOT,
      interpreter: '/usr/local/bin/node',
      watch: false,
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },

    // ── 2. semantic-vision（Ollama minicpm-v 主 + mlx_vlm 降级）──
    //    vision-daemon（摄像头）由 LaunchAgent 管理，需要 Aqua session
    //    注意：用 tools/vision/ 版（Ollama 主），不要用根目录版（MLX only，模型未缓存）
    {
      name: 'semantic-vision',
      script: 'tools/vision/semantic_vision_daemon.py',
      cwd: BRAIN_ROOT,
      interpreter: VENV_PYTHON,
      args: `--data-dir ${DATA_ACTIVITY}`,
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 5,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};

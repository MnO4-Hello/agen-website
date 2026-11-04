/**
 * PM2 进程配置（生产环境常驻后端）。
 *
 * 在仓库根目录执行：
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *
 * 为什么是 `.cjs`：根 package.json 没写 `"type": "module"`，但 PM2 读配置时按 CommonJS
 * 解析最稳；显式后缀能避免以后给根目录加 `"type": "module"` 时把这份配置搞坏。
 */

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'agen-api',
      // cwd 固定成仓库根：`.env` 由 dist/server.js 自己从仓库根读，
      // 但 `ADMIN_FILE_ROOTS` 里的相对路径是相对这里的，所以必须钉死。
      cwd: __dirname,
      script: path.join(__dirname, 'apps/api/dist/server.js'),

      // ⚠️ 必须单实例。数据层是「JSON 文件 + 进程内缓存」，多实例会互相覆盖写，
      // 表现出「刚发的留言刷新就没了」。要横向扩容得先换掉这套存储。
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      /*
       * 768M 而不是 512M：`apps/api/src/media/derivatives.ts` 用 sharp 解码原图，
       * 最坏情况（36MP 的 PNG）解码缓冲约 144MB，加上输入 buffer 与 Node 常驻，
       * 512M 会在一次大图上传的中途触发重启，把那次上传直接丢掉。
       * 机器是 1C2G，768M 留出的余量够 SSE 控制台与 JSON 缓存用。
       */
      max_memory_restart: '768M',
      // 崩得太快时给个退避，避免把 CPU 打满
      restart_delay: 2000,
      min_uptime: '10s',

      env: {
        NODE_ENV: 'production',
        // PORT / HOST / ADMIN_* / TRUST_PROXY 都在仓库根的 .env 里，不在这里重复
      },

      out_file: path.join(__dirname, 'logs/pm2-out.log'),
      error_file: path.join(__dirname, 'logs/pm2-err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};

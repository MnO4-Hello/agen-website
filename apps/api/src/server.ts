import { fileURLToPath } from 'node:url';

import { installLogCapture } from './admin/log-buffer.js';
import { buildApp } from './app.js';

// 控制台要能看到**启动阶段**的日志，所以钩子必须在建 Fastify 之前装上（logger 一创建就开始
// 往 stdout 写）。钩子只旁听，不改写也不吞掉任何输出。
installLogCapture();

// 根目录的 `.env` 在这里由 Node 原生读取（Node ≥ 20.12 提供 `process.loadEnvFile`），
// 不引 dotenv。**必须在读任何环境变量之前**执行，所以放在 import 之后、第一次使用之前。
// 已经存在的环境变量优先（与 `--env-file` 的语义一致），所以 `PORT=4000 npm run dev:api`
// 这种临时覆盖照旧生效。文件不存在就静默跳过——`.env` 是可选的。
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // 没有 .env：走各处的默认值（PORT 3000；管理员接口则 fail-closed 返回 503）。
}

const port = Number(process.env.PORT ?? 3000);
// 0.0.0.0 keeps the server reachable from other machines/containers.
const host = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();

// 后台会话的签名密钥有没有配，启动时就在日志里说清楚——否则要到打开登录页才 503，很难查。
// 账号密码不再走环境变量：登录只认 users.json 里的 owner / admin 账号（见 routes/admin.ts）。
if (!process.env.ADMIN_SESSION_SECRET) {
  app.log.warn(
    'ADMIN_SESSION_SECRET 未配置，/api/admin/* 会返回 503；' +
      '要启用请复制 .env.example 为 .env 并填好 ADMIN_SESSION_SECRET（后台登录用站内站长账号）。',
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

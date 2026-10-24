import { fileURLToPath } from 'node:url';

import { defineConfig, loadEnv } from 'vite';

/** 把仓库内相对本文件的路径转成绝对路径（ESM 下没有 `__dirname`）。 */
const html = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // API_PORT is an optional alias; PORT matches what apps/api reads.
  const apiPort = env.API_PORT || env.PORT || '3000';
  const webPort = Number(env.WEB_PORT || 5173);

  // Keeps the browser on a single origin, so the same relative '/api' calls work in
  // dev, in preview and in production. 没配这条的话，`npm run preview` 下管理员页
  // 的登录请求会 404（preview 与 dev 是两套服务器，代理要各写一次）。
  const apiProxy = {
    '/api': {
      target: `http://localhost:${apiPort}`,
      changeOrigin: true,
    },
  };

  return {
    server: {
      port: webPort,
      // Bind to all network interfaces so LAN devices can access the dev server.
      host: true,
      proxy: apiProxy,
    },
    preview: {
      port: webPort,
      proxy: apiProxy,
    },
    build: {
      rollupOptions: {
        input: {
          // 主站：五个标签页都在这一个入口里，靠哈希路由切换（见 src/router.ts）。
          main: html('index.html'),
          // 隐藏的管理员页：**独立入口**，所以公开页面里没有任何指向它的引用，
          // 它的登录代码也不会进主站那份 bundle。地址是 /admin.html。
          admin: html('admin.html'),
        },
      },
    },
  };
});

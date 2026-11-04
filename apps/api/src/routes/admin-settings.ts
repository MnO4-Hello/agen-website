/**
 * 管理后台的「设置」：站点形态开关（`full` / `display` / `maintenance`）。
 *
 * 这是本项目**唯一一个能改变站点对外形态的写接口**，所以有三道约束：
 *
 *   1. **站长专属**。`admin/guard.ts` 的 `OWNER_ONLY` 里列了这两个路由，
 *      并且每个 handler 里还有一次 `requireAdmin()` 兜底（与其它管理路由同一套写法）。
 *   2. **先落盘再换内存**。写失败返回 500，内存保持原样——绝不出现「接口说成功、
 *      重启后变回去」。
 *   3. **审计**。每次真的改变都打一条 `warn` 日志（谁、从什么切到什么、关掉了哪些功能），
 *      同时把 `updatedAt` / `updatedBy` 写进文件，后台页面上能直接看到。
 *
 * 幂等：已经是目标模式时直接返回 `changed: false`，不写盘——否则每次点一下就会
 * 覆盖一次 `.bak`，真出问题时反而找不到上一版。
 */

import type { FastifyInstance } from 'fastify';

import { noStore, requireAdmin } from '../admin/session.js';
import { isSiteMode, SITE_MODES } from '../site/mode.js';
import {
  disabledFeatures,
  SITE_MODE_FILE_LABEL,
  siteModeSnapshot,
  writeSiteMode,
} from '../site/runtime.js';

export async function adminSettingsRoutes(app: FastifyInstance): Promise<void> {
  /** 读当前快照：模式、来源、上次改的人与时间、是否损坏。 */
  app.get('/admin/settings/site-mode', async (request, reply) => {
    noStore(reply);
    if (!requireAdmin(request, reply)) return;
    return reply.send({ site: siteModeSnapshot() });
  });

  app.put('/admin/settings/site-mode', async (request, reply) => {
    noStore(reply);
    const user = requireAdmin(request, reply);
    if (!user) return;

    const mode = (request.body as { mode?: unknown } | null)?.mode;
    if (!isSiteMode(mode)) {
      return reply.code(400).send({
        error: 'invalid_mode',
        message: `mode 只能是 ${SITE_MODES.join(' / ')} 之一。`,
      });
    }

    const before = siteModeSnapshot().mode;
    if (before === mode) {
      return reply.send({ site: siteModeSnapshot(), changed: false });
    }

    let site: ReturnType<typeof siteModeSnapshot>;
    try {
      // 用后台里显示的那个名字（昵称 / .env 用户名）记审计，和 UI 上的身份一致。
      site = await writeSiteMode(mode, request.adminActor?.name ?? user);
    } catch (error) {
      request.log.error(`切换站点模式失败（${before} → ${mode}）：${(error as Error).message}`);
      return reply.code(500).send({
        error: 'site_mode_write_failed',
        message: `写 ${SITE_MODE_FILE_LABEL} 失败，模式没有改变：${(error as Error).message}`,
      });
    }

    const off = disabledFeatures(site);
    request.log.warn(
      `站点模式 ${before} → ${site.mode}（${site.updatedBy}）${
        off.length > 0 ? `，已关闭：${off.join(' / ')}` : '，全部功能开放'
      }`,
    );
    return reply.send({ site, changed: true });
  });
}

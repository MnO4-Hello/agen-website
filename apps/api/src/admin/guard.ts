/**
 * 管理接口的统一「第一道门」——一个挂在根实例上的 `onRequest` 钩子。
 *
 * 为什么不改那 37 处 `requireAdmin()`：
 *
 *   · `requireAdmin()` 是**同步**的纯签名校验，而且它在每个路由里只占一行。
 *     要让它「回表看这个人现在还是不是管理员」，就得改成 async，等于把 6 个
 *     路由文件、几十处调用一起翻一遍——纯机械改动，收益全在别处，风险全在这里。
 *   · 钩子只需在 `app.ts` 里加一行，就能拿到**异步回表**的能力：账号被删、被停用、
 *     被封禁、被降级，下一次请求立刻 401。这同时修掉了一个已知隐患——后台会话是
 *     无状态 token，此前降级一个管理员之后，他最多还能继续用 2 小时。
 *
 * 两条容易写错的地方，改之前先读：
 *
 *   1. **必须挂根实例**（`app.addHook`），不能写成 `app.register(plugin, { prefix })`。
 *      带 prefix 的插件只创建自己的作用域，罩不住**兄弟插件**里注册的
 *      `adminWorksRoutes` 等路由。Fastify 的钩子对「之后注册」的路由生效，
 *      所以 `installAdminGuard()` 必须排在所有 `app.register(路由)` 之前。
 *   2. **用 `routeOptions.url`（路由模板）而不是 `request.url`（真实路径）**。
 *      前者是 `/api/admin/works/:id`，可以直接和策略表比字符串；后者是
 *      `/api/admin/works/9f3c…`，得写一堆正则。
 *
 * 兜底：路由里的 `requireAdmin()` **保留不动**。万一有人把这里挪错了位置，
 * 最坏结果是退回「admin 与 owner 等价」的旧模型，而不是后台完全失守。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isActive } from '../users/moderation.js';
import { findByLogin } from '../users/store.js';
import { UserError } from '../users/validate.js';
import { isOwner, type AdminActor } from './permissions.js';
import {
  ADMIN_COOKIE,
  adminCookieHeader,
  noStore,
  readAdminConfig,
  readCookie,
  verifyToken,
} from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** 由 `installAdminGuard()` 填入；`/api/admin/*` 的业务路由可以放心取。 */
    adminActor?: AdminActor;
  }
}

/** 这三个是「还没有身份」的入口，必须放行，否则永远登不进来/退不出去。 */
const OPEN_ROUTES = new Set(['/api/admin/session', '/api/admin/login', '/api/admin/logout']);

/**
 * 只有站长能碰的路由（`方法 + 路由模板`）。
 *
 * 这份表是权限的**第二道锁**：`admin-accounts.ts` 里的徽章接口自己也会断言 owner，
 * 但把「内容生产」集中列在这里，比在 6 个路由文件里各埋一行更好审计——
 * 想知道「管理员到底能不能发帖」，看这一个常量就够了。
 */
const OWNER_ONLY = new Set([
  // 作品：从新建到排序，全部属于内容生产。
  'POST /api/admin/works',
  'PUT /api/admin/works/:id',
  'DELETE /api/admin/works/:id',
  'POST /api/admin/works/:id/publish',
  'POST /api/admin/works/reorder',
  'POST /api/admin/works/media',
  // 博客：正文、删除、插图、分类都是内容生产；只有「上/下架」留给管理员当审核手段。
  'POST /api/admin/blog/media',
  'POST /api/admin/blog/posts',
  'PUT /api/admin/blog/posts/:id',
  'DELETE /api/admin/blog/posts/:id',
  'POST /api/admin/blog/categories',
  'PUT /api/admin/blog/categories/:id',
  'DELETE /api/admin/blog/categories/:id',
  'POST /api/admin/blog/categories/reorder',
  // 留言的「站长回复」会以前台站长身份署名，不能给管理员用；隐藏/恢复不限。
  'POST /api/admin/messages/:id/replies',
  // 徽章：目录与授予。
  'POST /api/admin/badges',
  'PUT /api/admin/badges/:id',
  'DELETE /api/admin/badges/:id',
  'POST /api/admin/badges/:id/restore',
  'POST /api/admin/accounts/:id/badges',
  'DELETE /api/admin/accounts/:id/badges/:badgeId',
]);

/**
 * 路由模板。多数情况下 `routeOptions.url` 已经带 `/api` 前缀（注册时用了 prefix），
 * 但不同 Fastify 版本/注册方式下有过不带的情况，这里统一补齐，免得策略表静默失配。
 */
function routeTemplate(request: FastifyRequest): string {
  const raw = request.routeOptions.url ?? '';
  if (!raw) return '';
  if (raw.startsWith('/api/')) return raw;
  return raw.startsWith('/') ? `/api${raw}` : `/api/${raw}`;
}

/**
 * 把 token 里的 `sub` 解析成一个「现在还有效」的操作者。
 *
 * `sub === ADMIN_USER` 视为 `.env` 管理员：永远 owner，且**没有** users.json 记录，
 * 所以任何账号操作（封禁、降级）都碰不到它——这是最后一道兜底。
 */
async function resolveActor(sub: string, envUser: string): Promise<AdminActor | null> {
  if (sub === envUser) {
    return { name: sub, role: 'owner', userId: null, source: 'env' };
  }

  // 普通账号登录的后台会话：每次请求回表，所以停用/封禁/降级立即生效。
  const account = await findByLogin(sub);
  if (!account || !isActive(account)) return null;
  if (account.role !== 'owner' && account.role !== 'admin') return null;

  return {
    name: account.nickname || account.username,
    role: account.role,
    userId: account.id,
    source: 'account',
  };
}

/** 读 cookie + 验签 + 回表。`/admin/session` 这种「公开但要报身份」的接口也用它。 */
export async function resolveCurrentActor(request: FastifyRequest): Promise<AdminActor | null> {
  const config = readAdminConfig();
  if (!config) return null;
  const token = readCookie(request, ADMIN_COOKIE);
  const sub = token ? verifyToken(token, config.secret) : null;
  return sub ? resolveActor(sub, config.user) : null;
}

/**
 * 取当前操作者。
 *
 * 只在 `installAdminGuard()` 覆盖的路由里调用（`/api/admin/*` 去掉三个公开入口）。
 * 取不到说明守卫没跑或顺序错了——这时**拒绝**比放行安全。
 */
export function currentActor(request: FastifyRequest): AdminActor {
  const actor = request.adminActor;
  if (!actor) throw new UserError(401, 'unauthorized', '会话已失效，请重新登录。');
  return actor;
}

export function installAdminGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    // CORS 预检不带 cookie，拦下来会让跨域部署整个不可用。
    if (request.method === 'OPTIONS') return;

    const route = routeTemplate(request);
    if (!route.startsWith('/api/admin/')) return;
    if (OPEN_ROUTES.has(route)) return;

    const config = readAdminConfig();
    if (!config) return reply.code(503).send({ error: 'admin_not_configured' });

    const token = readCookie(request, ADMIN_COOKIE);
    const sub = token ? verifyToken(token, config.secret) : null;
    const actor = sub ? await resolveActor(sub, config.user) : null;

    if (!actor) {
      noStore(reply);
      // 顺手清掉 cookie：否则浏览器会一直带着一颗已经没用的 token 重试。
      reply.header('set-cookie', adminCookieHeader('', config, 0));
      return reply.code(401).send({
        error: sub ? 'admin_revoked' : 'unauthorized',
        message: sub ? '你的后台权限已变更，请重新登录。' : '会话已失效，请重新登录。',
      });
    }

    if (!isOwner(actor) && OWNER_ONLY.has(`${request.method} ${route}`)) {
      noStore(reply);
      return reply.code(403).send({
        error: 'not_allowed',
        message: '内容只由站长发布，管理员可以审核但不能发布。',
      });
    }

    request.adminActor = actor;
  });
}

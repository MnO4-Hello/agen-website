/**
 * 站点账号的四个接口：查会话 / 注册 / 登录 / 登出。
 *
 * 与 `/api/admin/*` 的分工：这里是**面向访客**的账号系统（多用户、可注册），
 * 后台那套是单管理员的隐藏入口。两者共用同一份 `users.json` 的只有一件事——
 * 站长/管理员账号可以拿去登录 `admin.html`（见 `routes/admin.ts`）。
 *
 * 响应约定沿用项目现有的两种形状：
 *
 *   · 认证失败：`{ error: 'invalid_credentials' }` 这类英文码，附带一句中文 message；
 *   · 业务校验失败：`{ error, message, field }`，`field` 指向前端该红哪个输入框。
 *
 * 所有响应都 `no-store`：里面含「是否已登录」，被代理缓存下来就是事故。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { noStore } from '../admin/session.js';
import { failUser } from './error.js';
import {
  clearedUserCookieHeader,
  readUserSessionConfig,
  resolveUser,
  signUserToken,
  userCookieHeader,
} from '../users/session.js';
import { createUser, findByLogin, publicOf, recordLogin } from '../users/store.js';
import { DUMMY_HASH, verifyPassword } from '../users/password.js';
import { parseLoginBody, parseRegisterBody } from '../users/validate.js';

/* ---------------------------------------------------------------------------
   限流
--------------------------------------------------------------------------- */

/** 窗口 10 分钟；登录比注册宽松一点——输错密码是常事，反复注册不是。 */
const WINDOW_MS = 10 * 60 * 1000;

interface AttemptRecord {
  count: number;
  first: number;
}

/**
 * 进程内的失败计数。
 *
 * 单进程自用站点，不值得为它引 Redis。键是 `request.ip`——本项目没开 `trustProxy`，
 * 反向代理后面会全部算成同一个 IP；真上线到有代理的环境时要先配 `trustProxy`。
 *
 * **每个限制器一份 Map**：登录与注册的次数必须分开算，共用一个计数器会让
 * 「注册 5 次」把「登录 8 次」的额度一起吃掉。
 */
function createLimiter(max: number) {
  const attempts = new Map<string, AttemptRecord>();

  return {
    /** 记一次尝试。窗口过期就重新开始；已经用满就返回还要等多少秒。 */
    consume(ip: string): { allowed: boolean; retryAfterSeconds: number } {
      const now = Date.now();
      const record = attempts.get(ip);
      if (!record || now - record.first > WINDOW_MS) {
        attempts.set(ip, { count: 1, first: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (record.count >= max) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((WINDOW_MS - (now - record.first)) / 1000),
        };
      }
      record.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    clear(ip: string): void {
      attempts.delete(ip);
    },
  };
}

const loginLimit = createLimiter(8);
const registerLimit = createLimiter(5);

/* ---------------------------------------------------------------------------
   错误转换
--------------------------------------------------------------------------- */

/** 统一出口在 `routes/error.ts`（`routes/account.ts` 用同一份）。 */
const fail = failUser;

function tooMany(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(429).send({
    error: 'too_many_attempts',
    message: '尝试次数太多了，请稍后再试。',
    retryAfterSeconds,
  });
}

/* ---------------------------------------------------------------------------
   路由
--------------------------------------------------------------------------- */

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * 当前会话。
   *
   * 未登录一律 200 `{authenticated:false}`：这是「状态查询」不是权限校验，
   * 前端进页面先问一次，不该走错误分支（与 `/api/admin/session` 同一取舍）。
   */
  app.get('/auth/session', async (request, reply) => {
    noStore(reply);
    try {
      const user = await resolveUser(request);
      return reply.send(user ? { authenticated: true, user: publicOf(user) } : { authenticated: false });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/auth/register', async (request, reply) => {
    noStore(reply);
    try {
      const gate = registerLimit.consume(request.ip);
      if (!gate.allowed) return tooMany(reply, gate.retryAfterSeconds);

      const payload = parseRegisterBody(request.body);
      const record = await createUser({ ...payload, role: 'user' });

      registerLimit.clear(request.ip);
      const config = await readUserSessionConfig();
      reply.header(
        'set-cookie',
        userCookieHeader(
          signUserToken(record.id, config),
          config,
          Math.floor(config.ttlMs / 1000),
        ),
      );
      // 注册即登录：刚填完五个字段的人不该再填一遍。
      return reply.code(201).send({ user: publicOf(record) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/auth/login', async (request, reply) => {
    noStore(reply);
    try {
      const gate = loginLimit.consume(request.ip);
      if (!gate.allowed) return tooMany(reply, gate.retryAfterSeconds);

      const { identifier, password } = parseLoginBody(request.body);
      const record = await findByLogin(identifier);

      // 账号不存在时也跑一次 scrypt：否则「没这个人」立刻返回、「密码错」要等 60ms，
      // 光看耗时就能把注册过的用户名/邮箱枚举出来。
      const passwordOk = await verifyPassword(password, record?.passwordHash ?? DUMMY_HASH);
      if (!record || !passwordOk) {
        return reply
          .code(401)
          .send({ error: 'invalid_credentials', message: '用户名/邮箱或密码不对。' });
      }

      // 停用放到密码通过之后再判：否则任何人输入一个存在的用户名都能探出「这个号被停了」。
      if (record.status !== 'active') {
        return reply
          .code(403)
          .send({ error: 'account_disabled', message: '这个账号已被停用，请联系站长。' });
      }

      loginLimit.clear(request.ip);
      const config = await readUserSessionConfig();
      // 登录时间只是信息字段，写失败不该让这次登录失败。
      void recordLogin(record.id).catch(() => undefined);

      reply.header(
        'set-cookie',
        userCookieHeader(signUserToken(record.id, config), config, Math.floor(config.ttlMs / 1000)),
      );
      return reply.send({ user: publicOf(record) });
    } catch (error) {
      return fail(app, reply, error);
    }
  });

  app.post('/auth/logout', async (_request, reply) => {
    noStore(reply);
    // 清 cookie 不需要 secret，也不需要「确实登录过」——重复登出必须是无害的。
    reply.header('set-cookie', clearedUserCookieHeader());
    return reply.send({ authenticated: false });
  });
}

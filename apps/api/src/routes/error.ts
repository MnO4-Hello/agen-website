/**
 * 账号类接口的错误出口。
 *
 * 原来 `routes/auth.ts` 里有一个私有的 `fail()`，`routes/account.ts` 需要一模一样的
 * 行为（`UserError` → `{ error, message, field? }`，其余 → 500）。抄一份就意味着
 * 以后改错误形状要改两处、漏一处。所以收敛到这里。
 *
 * 为什么**不**把 `works` 的 `fail()` 也合并进来：作品那边抛的是 `WorkError`，
 * 错误码前缀是 `work_error`，与账号的 `user_store_error` 是两套语义，强行统一
 * 会让「哪个模块出的错」变得看不出来。
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import { UserError } from '../users/validate.js';

export function failUser(
  app: FastifyInstance,
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof UserError) {
    return reply.code(error.status).send({
      error: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    });
  }
  app.log.error(error);
  return reply.code(500).send({
    error: 'user_store_error',
    message: '账号服务出错了，请稍后再试（后端控制台有详细日志）。',
  });
}

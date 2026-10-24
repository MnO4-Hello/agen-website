/**
 * 注册 / 登录请求的校验与归一化。
 *
 * 原则与 `works/validate.ts` 一致：**只报错，不尽力修正**。悄悄把 `" MnO4_ "`
 * 改成 `"MnO4_"` 再存进去，用户下次照着注册界面上看到的那个空格去登录会失败，
 * 而这种 bug 极难复现。所以原值怎么来就怎么报错，让填的人自己删。
 *
 * 唯一的例外是 `normalizeKey()`——它算的是**比较用的键**，不是存储值。
 */

import type { Role } from './types.js';

/**
 * 错误落在哪个输入框上，前端据此做内联提示。
 *
 * 除了注册/登录的几个字段，还包含个人中心里可编辑的字段名——校验层只有这一个
 * 「字段枚举」，多开一份就会跟界面上的 `name` 对不上。
 */
export type UserField =
  | 'username'
  | 'nickname'
  | 'email'
  | 'password'
  | 'newPassword'
  | 'confirmPassword'
  | 'currentPassword'
  | 'agreed'
  | 'signature'
  | 'bio'
  | 'gender'
  | 'birthday'
  | 'region'
  | 'socials'
  | 'tags'
  | 'badges'
  | 'theme'
  | 'privacy'
  | 'visibility'
  | 'customCss';

/**
 * 带 HTTP 状态码的业务错误。
 *
 * `code` 是给前端分支用的英文枚举（`username_taken` 等），`message` 是直接显示的中文。
 * 与项目现有约定一致：认证层用 `{ error }`，业务层用 `{ error, message }`。
 */
export class UserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: UserField,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export interface RegisterPayload {
  username: string;
  nickname: string;
  email: string;
  password: string;
}

export interface LoginPayload {
  identifier: string;
  password: string;
}

/**
 * 比较用的归一化键：去空白 → Unicode NFKC → 小写。
 *
 * NFKC 是必须的：全角 `Ａ`、`１` 与半角在视觉上几乎一样，不归一就能注册出两个
 * 肉眼无法区分的用户名（钓鱼的经典手法）。
 */
export function normalizeKey(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,19}$/;

/**
 * 保留字：这些名字一旦被注册，界面上就会出现「站长叫 admin」这种事。
 * 只挡完全相同的词（归一化后比较），不挡 `administrator2` 之类。
 */
const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'owner',
  'system',
  'support',
  'agen',
  'argon',
  'agn',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** 可打印 ASCII（0x21–0x7E）：允许符号，但不允许空格与制表符——密码里的空格最容易被吞掉。 */
const PASSWORD_CHARS_RE = /^[\x21-\x7E]{8,16}$/;

/** 昵称里不能出现的字符：控制符、零宽字符、行/段分隔符。 */
const NICKNAME_BAD_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/;

const NICKNAME_MAX = 24;

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 用户名：3–20 位、英文字母开头、只允许字母数字与 `_ - .`。 */
export function checkUsername(username: string): void {
  if (!USERNAME_RE.test(username)) {
    throw new UserError(
      400,
      'validation_error',
      '用户名需以英文字母开头，只能包含字母、数字、下划线、点和连字符，长度 3–20 位。',
      'username',
    );
  }
  if (RESERVED.has(normalizeKey(username))) {
    throw new UserError(400, 'validation_error', '这个用户名是保留字，换一个吧。', 'username');
  }
}

/** 昵称：唯一对外展示的名字，任意语言与符号，1–24 个字符（按码点算）。 */
export function checkNickname(nickname: string): void {
  if (NICKNAME_BAD_RE.test(nickname)) {
    throw new UserError(400, 'validation_error', '昵称里有不能使用的字符。', 'nickname');
  }
  const length = Array.from(nickname.trim()).length;
  if (length === 0 || length > NICKNAME_MAX) {
    throw new UserError(400, 'validation_error', `昵称不能为空，最多 ${NICKNAME_MAX} 个字符。`, 'nickname');
  }
}

export function checkEmail(email: string): void {
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new UserError(400, 'validation_error', '邮箱格式不对，请检查一下。', 'email');
  }
}

/** 密码：8–16 位可打印 ASCII，且必须同时含英文字母与数字（符号随便）。 */
export function checkPassword(password: string): void {
  const ok = PASSWORD_CHARS_RE.test(password) && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
  if (!ok) {
    throw new UserError(
      400,
      'validation_error',
      '密码需要 8–16 位，并且同时包含英文字母和数字。',
      'password',
    );
  }
}

export function parseRegisterBody(body: unknown): RegisterPayload {
  if (typeof body !== 'object' || body === null) {
    throw new UserError(400, 'invalid_body', '请求格式不对，请刷新页面再试一次。');
  }
  const raw = body as Record<string, unknown>;

  const username = asString(raw.username)?.trim() ?? '';
  const nickname = asString(raw.nickname)?.trim() ?? '';
  const email = asString(raw.email)?.trim() ?? '';
  const password = asString(raw.password) ?? '';

  checkUsername(username);
  checkNickname(nickname);
  checkEmail(email);
  checkPassword(password);

  // 确认密码是前端的主场，但服务端也顺手比一次：绕过界面直接打接口时不该能塞进不一致的值。
  const confirm = asString(raw.confirmPassword);
  if (confirm !== null && confirm !== password) {
    throw new UserError(400, 'validation_error', '两次输入的密码不一致。', 'confirmPassword');
  }

  if (raw.agreed !== true) {
    throw new UserError(
      400,
      'terms_required',
      '请先阅读并同意《用户协议》和《隐私政策》。',
      'agreed',
    );
  }

  return { username, nickname, email, password };
}

/**
 * 登录请求。
 *
 * 这里**不套用密码规则**：规则以后可能会收紧，老密码不该因此登不进来。
 * 只保证「非空、不是超长垃圾」就够了。
 */
export function parseLoginBody(body: unknown): LoginPayload {
  if (typeof body !== 'object' || body === null) {
    throw new UserError(400, 'invalid_body', '请求格式不对，请刷新页面再试一次。');
  }
  const raw = body as Record<string, unknown>;

  // 兼容两种写法：新的 `identifier`，以及后台表单沿用的 `username`。
  const identifier = (asString(raw.identifier) ?? asString(raw.username) ?? '').trim();
  const password = asString(raw.password) ?? '';

  if (!identifier || !password) {
    throw new UserError(400, 'validation_error', '账号和密码都要填。');
  }
  if (identifier.length > 254 || password.length > 200) {
    throw new UserError(400, 'validation_error', '账号或密码太长了。');
  }

  return { identifier, password };
}

export function assertRole(value: string): Role {
  if (value === 'user' || value === 'admin' || value === 'owner') return value;
  throw new UserError(400, 'validation_error', 'role 只能是 user / admin / owner。');
}

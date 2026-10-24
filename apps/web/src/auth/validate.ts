/**
 * 表单校验的纯函数版本。
 *
 * 规则与文案必须与 `apps/api/src/users/validate.ts` **逐字一致**：服务端是唯一权威，
 * 这里只是提前拦一次，好让错误在输入框下面出现、而不是等一次往返。改规则时两边一起改，
 * 否则会出现「前端放过了、后端 400」这种没人能看懂的情况。
 */

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,19}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const PASSWORD_CHARS_RE = /^[\x21-\x7E]{8,16}$/;
const NICKNAME_BAD_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/;

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

const NICKNAME_MAX = 24;

function normalize(value: string): string {
  return value.trim().normalize('NFKC').toLowerCase();
}

/** 输入框下面常驻的规则提示（不是错误，是「怎么填」）。 */
export const USERNAME_HINT = '字母开头，只能包含字母、数字、下划线、点和连字符，3–20 位';
export const PASSWORD_HINT = '8–16 位，必须同时包含英文字母和数字';
export const NICKNAME_HINT = '别人看到的名字，任意语言与符号都可以，最多 24 个字符';

export function usernameError(value: string): string | null {
  if (!USERNAME_RE.test(value)) {
    return '用户名需以英文字母开头，只能包含字母、数字、下划线、点和连字符，长度 3–20 位。';
  }
  if (RESERVED.has(normalize(value))) return '这个用户名是保留字，换一个吧。';
  return null;
}

export function nicknameError(value: string): string | null {
  if (NICKNAME_BAD_RE.test(value)) return '昵称里有不能使用的字符。';
  const length = Array.from(value.trim()).length;
  if (length === 0) return '昵称不能为空，最多 24 个字符。';
  if (length > NICKNAME_MAX) return `昵称不能为空，最多 ${NICKNAME_MAX} 个字符。`;
  return null;
}

export function emailError(value: string): string | null {
  const email = value.trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return '邮箱格式不对，请检查一下。';
  }
  return null;
}

export function passwordError(value: string): string | null {
  const ok = PASSWORD_CHARS_RE.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
  if (!ok) return '密码需要 8–16 位，并且同时包含英文字母和数字。';
  return null;
}

export function confirmError(password: string, confirm: string): string | null {
  if (password !== confirm) return '两次输入的密码不一致。';
  return null;
}

/** 登录只要求非空（老密码不该被后来收紧的规则挡住）。 */
export function loginError(identifier: string, password: string): string | null {
  if (!identifier.trim() || !password) return '账号和密码都要填。';
  return null;
}

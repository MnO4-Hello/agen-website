/**
 * 登录视图。
 *
 * 用真 `<form>` 而不是一堆 div：回车提交、密码管理器的自动填充、浏览器「保存密码」
 * 都靠它。`autocomplete` 明确写成 `username` / `current-password`，密码管理器才认得。
 *
 * 登录成功后不自己渲染面板，而是回调 `onSuccess`——面板的装配（导航、视图切换、
 * 会话过期回到登录页）都在 `main.ts` 里，登录视图不该知道这些。
 */

import { login, type SessionState } from '../api';
import { el } from '../ui';

export interface LoginOptions {
  /** 退出登录后再进来时把账号留在框里（少打一遍字）。 */
  prefill?: string;
  /** 顶部的提示，例如「已退出登录」「会话已过期」。 */
  message?: string;
  tone?: 'info' | 'error';
  onSuccess: (session: SessionState) => void;
}

export function renderLogin(root: HTMLElement, options: LoginOptions = { onSuccess: () => {} }): void {
  const card = el('section', { className: 'admin__card' });

  const title = el('h1', { className: 'admin__title', text: '管理员登录' });
  const hint = el('p', { className: 'admin__hint', text: '这个页面不在站内导航里。' });

  const form = el('form', { className: 'admin__form' });

  const fields: Array<{ name: string; type: string; autocomplete: string; label: string; value?: string }> = [
    { name: 'username', type: 'text', autocomplete: 'username', label: '账号', value: options.prefill },
    { name: 'password', type: 'password', autocomplete: 'current-password', label: '密码' },
  ];

  const inputs: HTMLInputElement[] = [];

  for (const field of fields) {
    const label = el('label', { className: 'admin__field' }, [
      el('span', { className: 'admin__label', text: field.label }),
    ]);

    const input = el('input', {
      className: 'admin__input',
      attrs: { name: field.name, type: field.type, autocomplete: field.autocomplete, required: true },
    });
    if (field.value) input.value = field.value;

    label.append(input);
    form.append(label);
    inputs.push(input);
  }

  const submit = el('button', { className: 'admin__submit', attrs: { type: 'submit' }, text: '登录' });
  form.append(submit);

  const status = el('p', {
    className: 'admin__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
    text: options.message ?? '',
  });
  if (options.tone === 'error' && options.message) status.classList.add('is-error');

  const setStatus = (message: string, tone: 'info' | 'error' = 'info'): void => {
    status.textContent = message;
    status.classList.toggle('is-error', tone === 'error');
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const [username, password] = inputs;
    if (!username.value || !password.value) {
      setStatus('账号和密码都要填。', 'error');
      return;
    }

    submit.disabled = true;
    username.disabled = true;
    password.disabled = true;
    submit.textContent = '登录中…';
    setStatus('');

    void login(username.value, password.value).then((result) => {
      if (result.ok) {
        options.onSuccess({ authenticated: true, user: result.user });
        return;
      }
      // 失败就原样留在表单上：账号留在输入框里（少打一遍字），密码清掉（别留在屏幕上）。
      submit.disabled = false;
      username.disabled = false;
      password.disabled = false;
      submit.textContent = '登录';
      password.value = '';
      password.focus();
      setStatus(result.message, 'error');
    });
  });

  card.append(title, hint, form, status);
  root.replaceChildren(card);
  inputs[0].focus();
}

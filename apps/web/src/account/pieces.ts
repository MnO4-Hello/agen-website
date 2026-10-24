/**
 * 个人中心的小组件。
 *
 * 全部是「建一次、之后只改属性」的形态（`set(value)` / `setStatus(...)`），
 * **没有任何一个会重建自己**——账号页的纪律是不许整块 `replaceChildren`，
 * 否则用户正在输的内容会被冲掉。
 *
 * ⚠️ 这里的类名是 `.acc-*`，样式在 `account.css`。**不要**用 `.admin-btn` 之类：
 * 后台的样式表属于 `admin.html` 那个独立 bundle，主站根本没有加载它。
 */

import { icon, type IconName } from '../admin/ui';
import type { CustomBadge, SystemBadge } from './types';

type Child = Node | string | null | undefined;

export interface ElOptions {
  className?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

/* ---------------------------------------------------------------------------
   按钮
--------------------------------------------------------------------------- */

export type ButtonTone = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonOptions {
  label?: string;
  tone?: ButtonTone;
  icon?: IconName;
  title?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function accButton(options: ButtonOptions): HTMLButtonElement {
  const tone = options.tone ?? 'default';
  const node = el('button', {
    className: `acc-btn acc-btn--${tone}`,
    attrs: { type: options.type ?? 'button', title: options.title ?? null },
  });
  if (options.icon) node.append(icon(options.icon, 15));
  if (options.label) node.append(el('span', { text: options.label }));
  node.disabled = options.disabled === true;
  if (options.onClick) node.addEventListener('click', options.onClick);
  return node;
}

export function accIconButton(name: IconName, label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', {
    className: 'acc-iconbtn',
    attrs: { type: 'button', 'aria-label': label, title: label },
  });
  node.append(icon(name, 15));
  node.addEventListener('click', onClick);
  return node;
}

/* ---------------------------------------------------------------------------
   表单
--------------------------------------------------------------------------- */

export interface FieldOptions {
  label: string;
  control: HTMLElement;
  hint?: string;
  /** 右上角的字数计数器；给了 `max` 才会显示。 */
  counter?: { max: number };
}

export interface FieldHandle {
  element: HTMLElement;
  setCount(value: number): void;
  setError(message: string | null): void;
}

export function accField(options: FieldOptions): FieldHandle {
  const head = el('div', { className: 'acc-field__head' }, [
    el('span', { className: 'acc-field__label', text: options.label }),
  ]);
  const count = el('span', { className: 'acc-field__count' });
  if (options.counter) head.append(count);
  else count.hidden = true;

  const error = el('span', { className: 'acc-field__error' });
  error.hidden = true;

  const wrap = el('label', { className: 'acc-field' }, [head, options.control]);
  if (options.hint) wrap.append(el('span', { className: 'acc-field__hint', text: options.hint }));
  wrap.append(error);

  return {
    element: wrap,
    setCount(value: number): void {
      if (!options.counter) return;
      count.textContent = `${value} / ${options.counter.max}`;
      count.classList.toggle('is-over', value > options.counter.max);
    },
    setError(message: string | null): void {
      error.textContent = message ?? '';
      error.hidden = !message;
      wrap.classList.toggle('is-invalid', Boolean(message));
    },
  };
}

export interface TextInputOptions {
  value: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'password' | 'date';
  autocomplete?: string;
  inputMode?: 'text' | 'email' | 'numeric';
  onInput?: (value: string) => void;
}

export function accInput(options: TextInputOptions): HTMLInputElement {
  const input = el('input', {
    className: 'acc-input',
    attrs: {
      type: options.type ?? 'text',
      placeholder: options.placeholder ?? null,
      autocomplete: options.autocomplete ?? 'off',
      inputmode: options.inputMode ?? null,
      spellcheck: 'false',
    },
  });
  input.value = options.value;
  input.addEventListener('input', () => options.onInput?.(input.value));
  return input;
}

export interface TextAreaOptions {
  value: string;
  placeholder?: string;
  rows?: number;
  onInput?: (value: string) => void;
}

export function accTextArea(options: TextAreaOptions): HTMLTextAreaElement {
  const area = el('textarea', {
    className: 'acc-input acc-input--area',
    attrs: {
      rows: options.rows ?? 5,
      placeholder: options.placeholder ?? null,
      spellcheck: 'false',
    },
  });
  area.value = options.value;
  area.addEventListener('input', () => options.onInput?.(area.value));
  return area;
}

/** 原生 select，够用且天然可访问（三档之外的地方用）。 */
export function accSelect<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
  onChange: (next: T) => void,
): HTMLSelectElement {
  const node = el('select', { className: 'acc-input acc-input--select' });
  for (const item of options) {
    const option = el('option', { text: item.label, attrs: { value: item.value } });
    node.append(option);
  }
  node.value = value;
  node.addEventListener('change', () => onChange(node.value as T));
  return node;
}

/* ---------------------------------------------------------------------------
   开关
--------------------------------------------------------------------------- */

export interface SwitchOptions {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface SwitchHandle {
  element: HTMLElement;
  set(checked: boolean): void;
}

/**
 * `role="switch"` 的按钮，不是 `<input type=checkbox>`。
 *
 * 理由：复选框要自己隐藏原生控件再画轨道，键盘/焦点的行为全靠手写；而一个按钮
 * 天然可聚焦、可回车触发，`aria-checked` 一写屏幕阅读器就懂。
 */
export function accSwitch(options: SwitchOptions): SwitchHandle {
  const knob = el('span', { className: 'acc-switch__track' }, [
    el('span', { className: 'acc-switch__dot' }),
  ]);
  const button = el('button', {
    className: 'acc-switch',
    attrs: { type: 'button', role: 'switch', 'aria-checked': String(options.checked) },
  }, [knob]);

  const text = el('span', { className: 'acc-switch__text' }, [
    el('span', { className: 'acc-switch__label', text: options.label }),
    ...(options.hint ? [el('span', { className: 'acc-switch__hint', text: options.hint })] : []),
  ]);

  const row = el('div', { className: 'acc-switchrow' }, [text, button]);

  const set = (checked: boolean): void => {
    button.setAttribute('aria-checked', String(checked));
    row.classList.toggle('is-on', checked);
  };
  set(options.checked);

  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    set(next);
    options.onChange(next);
  });

  return { element: row, set };
}

/* ---------------------------------------------------------------------------
   三档分段选择器
--------------------------------------------------------------------------- */

export interface SegmentedOptions<T extends string> {
  options: readonly { value: T; label: string; note?: string }[];
  value: T;
  /** `compact` 用于隐私面板那种一行一项的密集布局。 */
  compact?: boolean;
  onChange: (next: T) => void;
}

export interface SegmentedHandle<T extends string> {
  element: HTMLElement;
  set(value: T): void;
}

export function accSegmented<T extends string>(options: SegmentedOptions<T>): SegmentedHandle<T> {
  const group = el('div', {
    className: options.compact ? 'acc-seg acc-seg--compact' : 'acc-seg',
    attrs: { role: 'group' },
  });
  const buttons = new Map<T, HTMLButtonElement>();

  for (const item of options.options) {
    const button = el('button', {
      className: 'acc-seg__item',
      attrs: { type: 'button', 'aria-pressed': String(item.value === options.value) },
    }, [
      el('span', { className: 'acc-seg__label', text: item.label }),
      ...(item.note ? [el('span', { className: 'acc-seg__note', text: item.note })] : []),
    ]);
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      set(item.value);
      options.onChange(item.value);
    });
    buttons.set(item.value, button);
    group.append(button);
  }

  const set = (value: T): void => {
    for (const [key, button] of buttons) {
      button.setAttribute('aria-pressed', String(key === value));
    }
  };

  return { element: group, set };
}

/* ---------------------------------------------------------------------------
   状态行
--------------------------------------------------------------------------- */

export type StatusTone = 'info' | 'ok' | 'error';

export interface StatusHandle {
  element: HTMLElement;
  set(text: string, tone?: StatusTone, autoHideMs?: number): void;
  clear(): void;
  dispose(): void;
}

/**
 * 行内状态提示。
 *
 * 项目里**没有 toast**（`admin/views/works.ts` 也是这条路线）：提示就写在操作旁边，
 * 成功几秒后自动淡出，错误留着等下一次操作覆盖——错误通常需要人看见。
 */
export function accStatus(): StatusHandle {
  const node = el('p', {
    className: 'acc-status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  node.hidden = true;
  let timer = 0;

  const clear = (): void => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    node.textContent = '';
    node.hidden = true;
    node.classList.remove('is-ok', 'is-error');
  };

  return {
    element: node,
    set(text, tone = 'info', autoHideMs = 4000) {
      clear();
      if (!text) return;
      node.textContent = text;
      node.hidden = false;
      node.classList.toggle('is-ok', tone === 'ok');
      node.classList.toggle('is-error', tone === 'error');
      if (tone !== 'error' && autoHideMs > 0) {
        timer = window.setTimeout(clear, autoHideMs);
      }
    },
    clear,
    dispose: clear,
  };
}

/* ---------------------------------------------------------------------------
   徽章 / 标签
--------------------------------------------------------------------------- */

/**
 * 系统徽章：实心深色底 + 小圆点 + 「系统」角标。
 *
 * 与自建徽章的差别是**物理性的**（实心 vs 描边、有没有角标）：用户能自建徽章，
 * 如果两种长得一样，任何人五分钟就能自封「官方认证」。截图裁掉角标也伪造不出
 * 左侧那个实心圆点。
 */
export function systemBadgeChip(badge: SystemBadge): HTMLElement {
  return el(
    'span',
    {
      className: 'acc-badge acc-badge--system',
      attrs: { title: badge.hint },
    },
    [
      el('span', { className: 'acc-badge__dot', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'acc-badge__label', text: badge.label }),
      el('span', { className: 'acc-badge__tag', text: '系统', attrs: { 'aria-label': '系统徽章' } }),
    ],
  );
}

export function customBadgeChip(badge: CustomBadge, onRemove?: () => void): HTMLElement {
  const node = el('span', { className: 'acc-badge acc-badge--custom' }, [
    ...(badge.emoji ? [el('span', { className: 'acc-badge__emoji', text: badge.emoji })] : []),
    el('span', { className: 'acc-badge__label', text: badge.label }),
  ]);
  node.style.setProperty('--badge-color', badge.color);
  if (onRemove) node.append(accIconButton('close', `删除徽章 ${badge.label}`, onRemove));
  return node;
}

export function tagChip(label: string, onRemove?: () => void): HTMLElement {
  const node = el('span', { className: 'acc-tag' }, [el('span', { text: label })]);
  if (onRemove) node.append(accIconButton('close', `删除标签 ${label}`, onRemove));
  return node;
}

/* ---------------------------------------------------------------------------
   分区容器
--------------------------------------------------------------------------- */

export interface BlockOptions {
  title: string;
  note?: string;
  action?: HTMLElement;
}

/** 设置页里的一块：标题 + 说明 + 内容，视觉上是分开的卡片。 */
export function accBlock(options: BlockOptions): { element: HTMLElement; body: HTMLElement } {
  const head = el('div', { className: 'acc-block__head' }, [
    el('h3', { className: 'acc-block__title', text: options.title }),
  ]);
  if (options.action) head.append(options.action);
  const element = el('section', { className: 'acc-block' }, [head]);
  if (options.note) element.append(el('p', { className: 'acc-block__note', text: options.note }));
  const body = el('div', { className: 'acc-block__body' });
  element.append(body);
  return { element, body };
}

/* ---------------------------------------------------------------------------
   杂项
--------------------------------------------------------------------------- */

/** 隐藏的文件选择器：每次现建现删，不用管 `value` 重置。 */
export function pickImage(onPicked: (file: File) => void): void {
  const input = el('input', {
    attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif', hidden: true },
  });
  const drop = (): void => input.remove();
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    drop();
    if (file) onPicked(file);
  });
  // 取消选择不会触发 change：不补这一条，这个 input 会一直挂在 body 上。
  input.addEventListener('cancel', drop);
  document.body.append(input);
  input.click();
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 码点长度（emoji 与中文都算 1），与服务端的计数方式一致。 */
export function charCount(value: string): number {
  return Array.from(value).length;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 一行「标签 : 值」；`value` 为空时返回 null，调用方直接过滤掉。 */
export function factRow(term: string, value: string | null | undefined): HTMLElement | null {
  if (!value) return null;
  return el('div', { className: 'acc-fact' }, [
    el('span', { className: 'acc-fact__term', text: term }),
    el('span', { className: 'acc-fact__value', text: value }),
  ]);
}

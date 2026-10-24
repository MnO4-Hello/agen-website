/**
 * 登录 / 注册页（`#login`、`#login/register`）。
 *
 * 三条实现纪律，都跟「不能让用户白填一遍」有关：
 *
 *   1. **两个表单同时存在于 DOM，切换只切 `hidden`**。用 `router.navigate()` 换 tab 会
 *      销毁整个视图（`hashchange → unmount`），已填的内容连同 DOM 一起没了。
 *   2. **协议正文也在同一个卡片里**，同样只切 `hidden`。看完点「返回」，
 *      勾选状态和五个输入框都还在。
 *   3. **哈希用 `history.replaceState` 同步**：它不触发 `hashchange`，所以既不重建视图、
 *      也不在后退历史里留下一串 tab 切换记录；刷新时又能凭哈希落回同一个 tab。
 *
 * 校验分两处：这里先跑一遍（错误显示在输入框下面），服务端再跑一遍（唯一性只能它判）。
 * 两边文案保持逐字一致，见 `auth/validate.ts` 顶部说明。
 */

import type { AuthFailure } from '../auth/api';
import {
  getAuthState,
  login,
  logout,
  register,
  subscribe,
  takeReturnTo,
} from '../auth/session';
import {
  PASSWORD_HINT,
  USERNAME_HINT,
  confirmError,
  emailError,
  loginError,
  nicknameError,
  passwordError,
  usernameError,
} from '../auth/validate';
import { parseHashRoute, type AppRoute } from '../app-routes';
import { createAvatar } from '../components/avatar';
import { AUTH_PAGE_COPY, PRIVACY, TERMS, type LegalDoc } from '../content/auth';
import type { RouteView } from '../router';
import type { ScrollToController } from '../scene/smooth-scroll';

export type AuthMode = 'login' | 'register';

export interface AuthPageOptions {
  readonly mode: AuthMode;
  readonly navigate: (route: AppRoute, param?: string | null) => void;
  readonly scrollTo: ScrollToController['scrollTo'];
}

type FieldKey = 'identifier' | 'username' | 'nickname' | 'email' | 'password' | 'confirmPassword';

interface FieldHandle {
  readonly wrap: HTMLElement;
  readonly input: HTMLInputElement;
  setError(message: string | null): void;
  value(): string;
  focus(): void;
}

interface FormHandle {
  readonly form: HTMLFormElement;
  readonly alert: HTMLElement;
  readonly submit: HTMLButtonElement;
  readonly submitLabel: string;
  readonly fields: Partial<Record<FieldKey, FieldHandle>>;
  busy: boolean;
}

/* ---------------------------------------------------------------------------
   小工具
--------------------------------------------------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 同一页里可能有 10 个输入框，id 必须唯一（label 的 for / aria-describedby 都用它）。 */
const uid = `auth-${Math.random().toString(36).slice(2, 8)}`;

interface FieldSpec {
  key: FieldKey;
  label: string;
  type: string;
  autocomplete: string;
  hint?: string;
  inputMode?: 'text' | 'email';
}

/**
 * `scope` 必须区分登录 / 注册两个表单：`password` 这个 key 在两边都有，
 * 不带作用域就会生成两个同 id 的 `<input>`，而 `<label for>` 只认第一个——
 * 点注册页的「密码」标签会跳去聚焦登录页那个（已隐藏的）输入框。
 */
function createField(spec: FieldSpec, scope: AuthMode): FieldHandle {
  const id = `${uid}-${scope}-${spec.key}`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const wrap = el('div', 'auth__field');
  const label = el('label', 'auth__label', spec.label);
  label.htmlFor = id;

  const input = el('input', 'auth__input');
  input.type = spec.type;
  input.id = id;
  input.name = spec.key;
  input.autocomplete = spec.autocomplete as AutoFill;
  if (spec.inputMode) input.inputMode = spec.inputMode;
  input.setAttribute('aria-describedby', spec.hint ? `${hintId} ${errorId}` : errorId);

  wrap.append(label, input);

  if (spec.hint) {
    const hint = el('p', 'auth__hint', spec.hint);
    hint.id = hintId;
    wrap.append(hint);
  }

  const error = el('p', 'auth__error');
  error.id = errorId;
  // 空元素不占位（CSS `:empty`），有错才把卡片撑开一行。
  error.setAttribute('role', 'alert');
  wrap.append(error);

  const setError = (message: string | null): void => {
    error.textContent = message ?? '';
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  input.addEventListener('input', () => {
    if (input.getAttribute('aria-invalid') === 'true') setError(null);
  });

  return {
    wrap,
    input,
    setError,
    value: () => input.value,
    focus: () => input.focus(),
  };
}

function clearErrors(form: FormHandle): void {
  for (const field of Object.values(form.fields)) field?.setError(null);
  form.alert.textContent = '';
}

function setBusy(form: FormHandle, busy: boolean, label: string, busyLabel: string): void {
  form.busy = busy;
  form.submit.disabled = busy;
  form.submit.textContent = busy ? busyLabel : label;
  for (const field of Object.values(form.fields)) {
    if (field) field.input.disabled = busy;
  }
}

/* ---------------------------------------------------------------------------
   页面
--------------------------------------------------------------------------- */

export function createAuthPage(options: AuthPageOptions): RouteView {
  let mode: AuthMode = options.mode;
  let view: 'form' | 'legal' = 'form';
  let savedScroll = 0;
  let legalTrigger: HTMLElement | null = null;

  const section = el('section', 'auth');
  const inner = el('div', 'auth__inner');

  /* ----- 左栏：一句说明 ----- */
  const aside = el('aside', 'auth__aside');
  aside.append(el('p', 'auth__eyebrow', AUTH_PAGE_COPY.eyebrow));

  const asideTitle = el('h1', 'auth__aside-title');
  // 文案里的 `\n` 是换行意图，用 `<br>` 落出来（`white-space: pre-line` 在标题上排版不稳）。
  AUTH_PAGE_COPY.asideTitle.split('\n').forEach((line, index) => {
    if (index > 0) asideTitle.append(document.createElement('br'));
    asideTitle.append(document.createTextNode(line));
  });
  aside.append(asideTitle, el('p', 'auth__aside-note', AUTH_PAGE_COPY.asideNote));

  /* ----- 右栏：卡片 ----- */
  const card = el('div', 'auth__card');

  const tabs = el('div', 'auth__tabs');
  tabs.setAttribute('role', 'tablist');
  const tabButtons: Record<AuthMode, HTMLButtonElement> = {
    login: el('button', 'auth__tab', AUTH_PAGE_COPY.tabLogin),
    register: el('button', 'auth__tab', AUTH_PAGE_COPY.tabRegister),
  };
  for (const [key, button] of Object.entries(tabButtons) as [AuthMode, HTMLButtonElement][]) {
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `${uid}-panel-${key}`);
    button.addEventListener('click', () => showMode(key));
    tabs.append(button);
  }

  /* ----- 登录表单 ----- */
  const loginForm = el('form', 'auth__form');
  loginForm.id = `${uid}-panel-login`;
  loginForm.noValidate = true;
  loginForm.setAttribute('role', 'tabpanel');
  loginForm.setAttribute('aria-label', AUTH_PAGE_COPY.loginTitle);

  const loginTitle = el('h2', 'auth__form-title', AUTH_PAGE_COPY.loginTitle);
  const loginNote = el('p', 'auth__form-note', AUTH_PAGE_COPY.loginNote);
  const loginAlert = el('p', 'auth__alert');
  loginAlert.setAttribute('role', 'alert');

  const identifierField = createField(
    {
      key: 'identifier',
      label: AUTH_PAGE_COPY.identifier,
      type: 'text',
      autocomplete: 'username',
      hint: AUTH_PAGE_COPY.identifierHint,
    },
    'login',
  );
  const loginPasswordField = createField(
    {
      key: 'password',
      label: AUTH_PAGE_COPY.password,
      type: 'password',
      autocomplete: 'current-password',
    },
    'login',
  );

  const loginSubmit = el('button', 'auth__submit', AUTH_PAGE_COPY.submitLogin);
  loginSubmit.type = 'submit';

  const loginSwitch = el('p', 'auth__switch');
  const toRegister = el('button', 'auth__switch-link', AUTH_PAGE_COPY.switchToRegisterAction);
  toRegister.type = 'button';
  toRegister.addEventListener('click', () => showMode('register'));
  loginSwitch.append(
    document.createTextNode(AUTH_PAGE_COPY.switchToRegister),
    toRegister,
  );

  loginForm.append(
    loginTitle,
    loginNote,
    loginAlert,
    identifierField.wrap,
    loginPasswordField.wrap,
    loginSubmit,
    loginSwitch,
  );

  const loginHandle: FormHandle = {
    form: loginForm,
    alert: loginAlert,
    submit: loginSubmit,
    submitLabel: AUTH_PAGE_COPY.submitLogin,
    fields: { identifier: identifierField, password: loginPasswordField },
    busy: false,
  };

  /* ----- 注册表单 ----- */
  const registerForm = el('form', 'auth__form');
  registerForm.id = `${uid}-panel-register`;
  registerForm.noValidate = true;
  registerForm.setAttribute('role', 'tabpanel');
  registerForm.setAttribute('aria-label', AUTH_PAGE_COPY.registerTitle);

  const registerTitle = el('h2', 'auth__form-title', AUTH_PAGE_COPY.registerTitle);
  const registerNote = el('p', 'auth__form-note', AUTH_PAGE_COPY.registerNote);
  const registerAlert = el('p', 'auth__alert');
  registerAlert.setAttribute('role', 'alert');

  const usernameField = createField(
    {
      key: 'username',
      label: AUTH_PAGE_COPY.username,
      type: 'text',
      autocomplete: 'username',
      // 产品要求：必须用括号讲清「用户名只用于登录」。
      hint: `${USERNAME_HINT}。${AUTH_PAGE_COPY.usernameHint}`,
    },
    'register',
  );
  const nicknameField = createField(
    {
      key: 'nickname',
      label: AUTH_PAGE_COPY.nickname,
      type: 'text',
      autocomplete: 'nickname',
      hint: '别人看到的名字，任意语言与符号都可以，最多 24 个字符',
    },
    'register',
  );
  const emailField = createField(
    {
      key: 'email',
      label: AUTH_PAGE_COPY.email,
      type: 'email',
      autocomplete: 'email',
      hint: AUTH_PAGE_COPY.emailHint,
      inputMode: 'email',
    },
    'register',
  );
  const passwordField = createField(
    {
      key: 'password',
      label: AUTH_PAGE_COPY.password,
      type: 'password',
      autocomplete: 'new-password',
      hint: PASSWORD_HINT,
    },
    'register',
  );
  const confirmField = createField(
    {
      key: 'confirmPassword',
      label: AUTH_PAGE_COPY.confirmPassword,
      type: 'password',
      autocomplete: 'new-password',
    },
    'register',
  );

  const agreeRow = el('div', 'auth__agree');
  const agreeLabel = el('label', 'auth__check');
  const agreeInput = el('input', 'auth__checkbox');
  agreeInput.type = 'checkbox';
  const agreeText = el('span', 'auth__check-text');
  agreeText.append(document.createTextNode(AUTH_PAGE_COPY.agreedPrefix));

  const termsButton = el('button', 'auth__legal-link', AUTH_PAGE_COPY.termsLabel);
  termsButton.type = 'button';
  const privacyButton = el('button', 'auth__legal-link', AUTH_PAGE_COPY.privacyLabel);
  privacyButton.type = 'button';

  termsButton.addEventListener('click', (event) => {
    // 按钮在 <label> 里，不拦的话点它会连带切换复选框。
    event.preventDefault();
    openLegal(TERMS, termsButton);
  });
  privacyButton.addEventListener('click', (event) => {
    event.preventDefault();
    openLegal(PRIVACY, privacyButton);
  });

  agreeText.append(
    termsButton,
    document.createTextNode(AUTH_PAGE_COPY.agreedAnd),
    privacyButton,
  );
  agreeLabel.append(agreeInput, agreeText);

  const agreeError = el('p', 'auth__error');
  agreeError.setAttribute('role', 'alert');
  agreeRow.append(agreeLabel, agreeError);

  agreeInput.addEventListener('change', () => {
    if (agreeInput.checked) agreeError.textContent = '';
  });

  const registerSubmit = el('button', 'auth__submit', AUTH_PAGE_COPY.submitRegister);
  registerSubmit.type = 'submit';

  const registerSwitch = el('p', 'auth__switch');
  const toLogin = el('button', 'auth__switch-link', AUTH_PAGE_COPY.switchToLoginAction);
  toLogin.type = 'button';
  toLogin.addEventListener('click', () => showMode('login'));
  registerSwitch.append(document.createTextNode(AUTH_PAGE_COPY.switchToLogin), toLogin);

  registerForm.append(
    registerTitle,
    registerNote,
    registerAlert,
    usernameField.wrap,
    nicknameField.wrap,
    emailField.wrap,
    passwordField.wrap,
    confirmField.wrap,
    agreeRow,
    registerSubmit,
    registerSwitch,
  );

  const registerHandle: FormHandle = {
    form: registerForm,
    alert: registerAlert,
    submit: registerSubmit,
    submitLabel: AUTH_PAGE_COPY.submitRegister,
    fields: {
      username: usernameField,
      nickname: nicknameField,
      email: emailField,
      password: passwordField,
      confirmPassword: confirmField,
    },
    busy: false,
  };

  /* ----- 已登录 ----- */
  const signed = el('div', 'auth__signed');
  const signedAvatar = el('div', 'auth__signed-avatar');
  const signedName = el('p', 'auth__signed-name');
  const signedHint = el('p', 'auth__signed-hint', AUTH_PAGE_COPY.signedInHint);
  const signedActions = el('div', 'auth__signed-actions');

  const goAccount = el('button', 'auth__submit', AUTH_PAGE_COPY.goAccount);
  goAccount.type = 'button';
  goAccount.addEventListener('click', () => options.navigate('account', 'profile'));

  const signedLogout = el('button', 'auth__submit auth__submit--ghost', AUTH_PAGE_COPY.logout);
  signedLogout.type = 'button';
  signedLogout.addEventListener('click', () => {
    signedLogout.disabled = true;
    void logout().finally(() => {
      signedLogout.disabled = false;
    });
  });

  signedActions.append(goAccount, signedLogout);
  signed.append(el('p', 'auth__signed-title', AUTH_PAGE_COPY.signedIn), signedAvatar, signedName, signedHint, signedActions);

  /* ----- 协议正文 ----- */
  const legalPanel = el('article', 'auth__legal');
  const legalHead = el('div', 'auth__legal-head');
  const legalBack = el('button', 'auth__legal-back', AUTH_PAGE_COPY.legalBack);
  legalBack.type = 'button';
  legalBack.addEventListener('click', () => closeLegal());
  const legalStamp = el('span', 'auth__legal-stamp');
  legalHead.append(legalBack, legalStamp);

  const legalTitle = el('h2', 'auth__legal-title');
  const legalIntro = el('p', 'auth__legal-intro');
  const legalBody = el('div', 'auth__legal-body');
  legalPanel.append(legalHead, legalTitle, legalIntro, legalBody);

  card.append(tabs, loginForm, registerForm, signed, legalPanel);
  inner.append(aside, card);
  section.append(inner);

  /* -------------------------------------------------------------------------
     状态切换
  ------------------------------------------------------------------------- */

  function syncVisibility(): void {
    const signedIn = getAuthState().status === 'user';
    const showForm = !signedIn && view === 'form';

    tabs.hidden = !showForm;
    legalPanel.hidden = view !== 'legal';
    signed.hidden = !signedIn || view === 'legal';
    loginForm.hidden = !showForm || mode !== 'login';
    registerForm.hidden = !showForm || mode !== 'register';

    tabButtons.login.classList.toggle('is-active', mode === 'login');
    tabButtons.register.classList.toggle('is-active', mode === 'register');
    tabButtons.login.setAttribute('aria-selected', String(mode === 'login'));
    tabButtons.register.setAttribute('aria-selected', String(mode === 'register'));
  }

  function showMode(next: AuthMode): void {
    mode = next;
    view = 'form';
    syncVisibility();

    // `replaceState` 不触发 `hashchange`：视图不会重建，已填内容原样保留，
    // 也不会在后退历史里堆一串 `#login` ⇄ `#login/register`。
    const hash = next === 'register' ? '#login/register' : '#login';
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }

  function openLegal(doc: LegalDoc, trigger: HTMLElement): void {
    savedScroll = window.scrollY;
    legalTrigger = trigger;
    view = 'legal';

    legalTitle.textContent = doc.title;
    legalStamp.textContent = `${AUTH_PAGE_COPY.legalUpdated} ${doc.updatedAt}`;
    legalIntro.textContent = doc.intro;

    // 结构化数据 + `textContent`：正文里不可能有能执行的标签。
    legalBody.replaceChildren();
    for (const entry of doc.sections) {
      legalBody.append(el('h3', 'auth__legal-heading', entry.heading));
      for (const paragraph of entry.paragraphs) {
        legalBody.append(el('p', 'auth__legal-paragraph', paragraph));
      }
    }

    syncVisibility();
    options.scrollTo(0, { immediate: true });
    legalBack.focus();
  }

  function closeLegal(): void {
    view = 'form';
    syncVisibility();
    options.scrollTo(savedScroll, { immediate: true });
    legalTrigger?.focus();
    legalTrigger = null;
  }

  function renderSigned(): void {
    const state = getAuthState();
    if (state.status !== 'user') return;
    signedAvatar.replaceChildren(
      createAvatar({ nickname: state.user.nickname, avatarUrl: state.user.avatarUrl, size: 'lg' }),
    );
    signedName.textContent = state.user.nickname;
  }

  /* -------------------------------------------------------------------------
     提交
  ------------------------------------------------------------------------- */

  /** 把服务端的失败落到具体的输入框上；没有 `field` 就显示在表单顶部。 */
  function applyFailure(handle: FormHandle, failure: AuthFailure): void {
    if (failure.field === 'agreed') {
      agreeError.textContent = failure.message;
      return;
    }
    const field = failure.field ? handle.fields[failure.field as FieldKey] : undefined;
    if (field) {
      field.setError(failure.message);
      field.focus();
      return;
    }
    handle.alert.textContent = failure.message;
  }

  function goAfterAuth(): void {
    const target = takeReturnTo('#home');
    const { route, param } = parseHashRoute(target);
    // 登录页 / 账号页不作为落点（回账号页会在未登录时又弹「请先登录」）。
    if (route === 'login') {
      options.navigate('home');
      return;
    }
    options.navigate(route, param);
  }

  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (loginHandle.busy) return;

    clearErrors(loginHandle);
    const identifier = identifierField.value().trim();
    const password = loginPasswordField.value();

    const problem = loginError(identifier, password);
    if (problem) {
      if (!identifier) identifierField.setError(problem);
      else loginPasswordField.setError(problem);
      (identifier ? loginPasswordField : identifierField).focus();
      return;
    }

    setBusy(loginHandle, true, AUTH_PAGE_COPY.submitLogin, AUTH_PAGE_COPY.submitting);
    void login({ identifier, password })
      .then((result) => {
        if (result.ok) {
          goAfterAuth();
          return;
        }
        // 密码错就清掉密码框，别让它留在屏幕上。
        loginPasswordField.input.value = '';
        loginPasswordField.focus();
        applyFailure(loginHandle, result);
      })
      .finally(() => {
        setBusy(loginHandle, false, AUTH_PAGE_COPY.submitLogin, AUTH_PAGE_COPY.submitting);
      })
      .catch(() => {
        loginAlert.textContent = '登录时出了点问题，请再试一次。';
      });
  });

  registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (registerHandle.busy) return;

    clearErrors(registerHandle);
    agreeError.textContent = '';

    const username = usernameField.value().trim();
    const nickname = nicknameField.value().trim();
    const email = emailField.value().trim();
    const password = passwordField.value();
    const confirmPassword = confirmField.value();

    // 按表单从上到下的顺序只报第一个问题：一次亮五行红字没人看得完。
    const checks: Array<[FieldHandle, string | null]> = [
      [usernameField, usernameError(username)],
      [nicknameField, nicknameError(nickname)],
      [emailField, emailError(email)],
      [passwordField, passwordError(password)],
      [confirmField, confirmError(password, confirmPassword)],
    ];
    for (const [field, problem] of checks) {
      if (!problem) continue;
      field.setError(problem);
      field.focus();
      return;
    }

    if (!agreeInput.checked) {
      agreeError.textContent = '请先阅读并同意《用户协议》和《隐私政策》。';
      agreeInput.focus();
      return;
    }

    setBusy(registerHandle, true, AUTH_PAGE_COPY.submitRegister, AUTH_PAGE_COPY.submitting);
    void register({ username, nickname, email, password, confirmPassword, agreed: true })
      .then((result) => {
        if (result.ok) {
          goAfterAuth();
          return;
        }
        applyFailure(registerHandle, result);
      })
      .finally(() => {
        setBusy(registerHandle, false, AUTH_PAGE_COPY.submitRegister, AUTH_PAGE_COPY.submitting);
      })
      .catch(() => {
        registerAlert.textContent = '注册时出了点问题，请再试一次。';
      });
  });

  /* -------------------------------------------------------------------------
     订阅登录态
  ------------------------------------------------------------------------- */

  const unsubscribe = subscribe((state) => {
    if (state.status === 'user') renderSigned();
    syncVisibility();
  });

  // 首次进入：把哈希补成规范形式（`#login/xxx` → `#login`），并同步 tab。
  const expected = mode === 'register' ? '#login/register' : '#login';
  if (window.location.hash !== expected) {
    window.history.replaceState(null, '', expected);
  }
  syncVisibility();

  return {
    elements: [section],
    dispose: () => {
      unsubscribe();
    },
  };
}

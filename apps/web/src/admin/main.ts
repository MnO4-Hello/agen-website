/**
 * 隐藏管理员页（`/admin.html`）的入口。
 *
 * 「隐藏」的含义是**这个地址不在站内任何地方出现**（不导航、不 sitemap、带 `noindex`），
 * 而不是「靠藏起来保护」——真正的门是账号密码，校验在后端 `apps/api/src/routes/admin.ts`。
 *
 * 这一版有两个功能：**控制台**（实时后端输出）与**文件管理**（白名单目录的增删改）。
 * 登录之后是「左侧功能卡 + 右侧内容」的外壳，见 `views/shell.ts`。
 *
 * 三个状态：`checking`（正在问后端有没有会话）→ `login` / `panel`。
 * 先问一次会话是必要的：cookie 还在时刷新页面不该再让人登录一遍。
 */

import './admin.css';
import { fetchSession, logout, type SessionState } from './api';
import { renderLogin } from './views/login';
import { renderShell, type AdminViewFactory, type AdminViewId } from './views/shell';

const hostElement = document.querySelector<HTMLElement>('#admin-root');

if (!hostElement) {
  throw new Error('Root element "#admin-root" was not found in admin.html');
}

/** 上面断言过就一定存在；单独取个 const，闭包里也能保持非空类型。 */
const root: HTMLElement = hostElement;

/** 当前挂着的界面，换状态前先 dispose（控制台的 SSE 连接靠它断开）。 */
let current: { dispose: () => void } | null = null;

/** 当前状态。用来挡住「会话过期」在登录页上再弹一次登录页。 */
let mode: 'checking' | 'login' | 'panel' = 'checking';

function mount(next: { dispose: () => void }): void {
  current?.dispose();
  current = next;
}

function showPanel(
  session: SessionState,
  views?: Partial<Record<AdminViewId, AdminViewFactory>>,
  initialView?: AdminViewId,
): void {
  const shell = renderShell(root, session, {
    views,
    initialView,
    onSignOut: () => {
      void logout().then(() => {
        // 账号留着：同一台机器上大概率还是同一个人再登一次。
        showLogin({ prefill: session.user, message: '已退出登录。' });
      });
    },
  });
  mount(shell);
  mode = 'panel';
}

function showLogin(options: { prefill?: string; message?: string; tone?: 'info' | 'error' } = {}): void {
  // 先拆掉旧外壳再画表单：`admin--shell` 这个类会影响根容器的布局。
  current?.dispose();
  current = null;
  mode = 'login';
  renderLogin(root, {
    ...options,
    onSuccess: (session) => showPanel(session),
  });
}

/** 任意接口返回 401（会话过期 / cookie 被清）都会走到这里。 */
window.addEventListener('admin:unauthorized', () => {
  if (mode !== 'panel') return;
  showLogin({ message: '会话已过期，请重新登录。', tone: 'error' });
});

function renderChecking(): void {
  mode = 'checking';
  const card = document.createElement('section');
  card.className = 'admin__card';
  const text = document.createElement('p');
  text.className = 'admin__hint';
  text.textContent = '正在检查登录状态…';
  card.append(text);
  root.replaceChildren(card);
}

/**
 * DEV 截图通道：`/admin.html?preview=console` 用假数据直接渲染面板。
 *
 * 只为了「改完样式能看一眼」，**不会连后端**；生产构建里 `import.meta.env.DEV` 是
 * `false`，这段连同 `preview.ts` 一起被摇掉。
 */
async function maybePreview(): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  const requested = new URLSearchParams(location.search).get('preview');
  if (requested !== 'console' && requested !== 'files' && requested !== 'works') return false;

  const { createPreviewViews } = await import('./preview');
  showPanel({ authenticated: true, user: 'admin' }, createPreviewViews(requested), requested);
  return true;
}

/** `?view=` 可直达的功能。加新视图时记得同步这里，否则深链会静默落到控制台。 */
const DEEP_LINKS: readonly AdminViewId[] = ['console', 'files', 'works'];

async function boot(): Promise<void> {
  if (await maybePreview()) return;

  renderChecking();
  const session = await fetchSession();
  if (session?.authenticated) {
    // `?view=works` 可以直接落到某个功能（截图、书签都方便）；其余一律从控制台开始。
    const requested = new URLSearchParams(location.search).get('view');
    const initialView = DEEP_LINKS.find((id) => id === requested);
    showPanel(session, undefined, initialView);
    return;
  }
  showLogin();
  // 后端连不上 / 没配好时，这里不直接报错：先让人看到表单，提交时再由登录接口给出
  // 具体原因（503 的提示就写在 `api.ts` 里）。查询失败本身不算异常状态。
}

void boot();

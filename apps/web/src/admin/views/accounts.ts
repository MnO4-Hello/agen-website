/**
 * 后台「账户」：所有人的账号在这里一览、处置。
 *
 * 布局与 `guestbook.ts` 同一套纪律：
 *
 *   · **没有 modal**。项目里至今没有任何弹窗，所有操作都是行内展开一块面板；
 *     可逆操作（解封、撤销徽章）点了就生效，不可逆或影响较大的（封禁、改角色）
 *     必须先在面板里选完时长/角色再点确认——「永久封禁」绝不能一键误触。
 *   · **权限位全部来自服务端**（`account.can.*`）。前端不重写「管理员能不能改站长」
 *     这套矩阵，只负责 `disabled` + `title` 说明原因。两边各写一份的话，
 *     不一致的方向一定是「界面以为不能点、接口其实放行」。
 *   · **状态反馈只有顶部一行** `role="status"`，成功自动淡出、错误留着。
 *
 * 一屏的信息密度按「一眼能判断该不该动手」排：
 * 昵称/用户名 → 角色与处罚 → 邮箱 → 注册与最后登录 → 徽章。
 */

import {
  type AccountRole,
  type AccountSanction,
  type AdminAccount,
  type AdminAccountPage,
  type AdminBadge,
} from '../api';
import { isOwner } from '../role';
import { button, el, formatDateTime } from '../ui';
import { liveAccountSource, type AccountSource } from './account-source';
import type { AdminView } from './view';
import '../admin-accounts.css';

const SEARCH_DEBOUNCE_MS = 300;

/** 与后端 `SANCTION_DAYS` 必须一致；`0` = 永久。 */
const DURATIONS = [
  { days: 1, label: '1 天' },
  { days: 3, label: '3 天' },
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 0, label: '永久' },
] as const;

const ROLE_LABEL: Record<AccountRole, string> = {
  user: '普通用户',
  admin: '管理员',
  owner: '站长',
};

type StateFilter = 'all' | 'active' | 'banned' | 'muted' | 'disabled';
type PanelKind = 'ban' | 'mute' | 'role' | 'badge';

function untilText(until: string | null): string {
  if (until === null) return '永久';
  const ms = Date.parse(until);
  return Number.isNaN(ms) ? '永久' : formatDateTime(ms);
}

function sanctionText(kind: 'ban' | 'mute', sanction: AccountSanction): string {
  const verb = kind === 'ban' ? '封禁' : '禁言';
  return sanction.until === null ? `永久${verb}` : `${verb}至 ${untilText(sanction.until)}`;
}

export function createAccountsView(source: AccountSource = liveAccountSource): AdminView {
  let closed = false;
  let busy = false;
  let timer = 0;
  let statusTimer = 0;

  const state = {
    q: '',
    role: 'all' as AccountRole | 'all',
    state: 'all' as StateFilter,
    page: 1,
    data: null as AdminAccountPage | null,
  };

  /** 徽章目录按需加载（很多人根本不会点开「徽章」）。 */
  let catalog: { badges: AdminBadge[]; archived: AdminBadge[] } | null = null;

  /** 同时只开一块面板：一屏开着五个输入框，反而不知道自己在改谁。 */
  let openPanel: { id: string; kind: PanelKind } | null = null;

  /** 理由草稿：重画列表不能把人家正打的字弄丢。 */
  const drafts = new Map<string, string>();

  /* 外壳 ---------------------------------------------------------------- */

  const root = el('div', { className: 'acm' });

  const count = el('span', { className: 'acm__count', text: '' });
  const refresh = button({
    className: 'admin-btn admin-btn--ghost',
    text: '刷新',
    onClick: () => void load(true),
  });
  const top = el('div', { className: 'acm__top' }, [count, refresh]);

  const search = el('input', {
    className: 'admin-input admin-input--search',
    attrs: { type: 'search', placeholder: '搜用户名 / 昵称 / 邮箱…', 'aria-label': '搜索账号' },
  });

  const roleSelect = el('select', {
    className: 'admin-select',
    attrs: { 'aria-label': '按角色筛选' },
  });
  for (const [value, label] of [
    ['all', '全部角色'],
    ['owner', '站长'],
    ['admin', '管理员'],
    ['user', '普通用户'],
  ] as const) {
    roleSelect.append(el('option', { text: label, attrs: { value } }));
  }

  const stateSelect = el('select', {
    className: 'admin-select',
    attrs: { 'aria-label': '按状态筛选' },
  });
  for (const [value, label] of [
    ['all', '全部状态'],
    ['active', '正常'],
    ['banned', '已封禁'],
    ['muted', '已禁言'],
    ['disabled', '已停用'],
  ] as const) {
    stateSelect.append(el('option', { text: label, attrs: { value } }));
  }

  const filters = el('div', { className: 'acm__filters' }, [search, roleSelect, stateSelect]);

  const statusLine = el('p', {
    className: 'acm__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  statusLine.hidden = true;

  const list = el('ul', { className: 'acm__list' });
  const pager = el('div', { className: 'acm__pager' });

  root.append(top, filters, statusLine, list, pager);

  /* 状态提示 ------------------------------------------------------------ */

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    statusLine.textContent = text;
    statusLine.hidden = !text;
    statusLine.classList.toggle('is-error', tone === 'error');
    statusLine.classList.toggle('is-ok', tone === 'ok');
    if (statusTimer) window.clearTimeout(statusTimer);
    if (text && tone !== 'error') {
      statusTimer = window.setTimeout(() => {
        statusLine.textContent = '';
        statusLine.hidden = true;
      }, 4000);
    }
  }

  /* 数据 ---------------------------------------------------------------- */

  async function load(silent = false): Promise<void> {
    if (busy) return;
    busy = true;
    if (!silent) setStatus('正在读取账号…');
    const result = await source.list({
      q: state.q,
      role: state.role,
      state: state.state,
      page: state.page,
      size: 20,
    });
    busy = false;
    if (closed) return;

    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    state.data = result.data;
    // 删到只剩空页时（比如筛出来的人数变少）自动退回上一页，别让人对着空白发呆。
    if (result.data.accounts.length === 0 && result.data.page > 1) {
      state.page = Math.max(1, result.data.page - 1);
      void load(true);
      return;
    }
    if (!silent) setStatus('');
    render();
  }

  /** 操作完统一走这里：重新拉一页，比在本地拼数据可靠（服务端还会重算 can.*）。 */
  async function afterWrite(result: { ok: true } | { ok: false; message: string }, okText: string) {
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    openPanel = null;
    setStatus(okText, 'ok');
    await load(true);
  }

  /* 渲染 ---------------------------------------------------------------- */

  function render(): void {
    const data = state.data;
    if (!data) return;

    count.textContent = `共 ${data.counts.total} 个账号 · ${data.counts.owners} 位站长 · ${data.counts.admins} 位管理员 · ${data.counts.banned} 个封禁中 · ${data.counts.muted} 个禁言中`;

    list.replaceChildren();
    if (data.accounts.length === 0) {
      list.append(el('li', { className: 'admin-empty', text: '没有符合条件的账号。' }));
    } else {
      for (const account of data.accounts) list.append(renderRow(account));
    }

    renderPager(data);
  }

  function renderPager(data: AdminAccountPage): void {
    pager.replaceChildren();
    const pages = Math.max(1, Math.ceil(data.total / data.size));
    if (pages <= 1) return;

    const prev = button({
      className: 'admin-btn admin-btn--ghost',
      text: '上一页',
      disabled: data.page <= 1,
      onClick: () => {
        state.page = Math.max(1, data.page - 1);
        void load();
      },
    });
    const next = button({
      className: 'admin-btn admin-btn--ghost',
      text: '下一页',
      disabled: data.page >= pages,
      onClick: () => {
        state.page = Math.min(pages, data.page + 1);
        void load();
      },
    });
    pager.append(prev, el('span', { className: 'acm__pageno', text: `${data.page} / ${pages}` }), next);
  }

  function pill(text: string, variant: 'role' | 'ban' | 'mute' | 'muted'): HTMLElement {
    return el('span', { className: `acm__pill acm__pill--${variant}`, text });
  }

  function renderRow(account: AdminAccount): HTMLLIElement {
    const node = el('li', { className: 'acm__row' });

    const avatar = el('span', {
      className: 'acm__avatar',
      text: (account.nickname || account.username).slice(0, 1).toUpperCase(),
    });

    const idBox = el('div', { className: 'acm__id' }, [
      el('span', { className: 'acm__name', text: account.nickname }),
      el('span', { className: 'acm__handle', text: `@${account.username}` }),
    ]);

    const tags = el('div', { className: 'acm__tags' });
    tags.append(pill(ROLE_LABEL[account.role], 'role'));
    if (account.ban) {
      tags.append(pill(sanctionText('ban', account.ban), account.ban.active ? 'ban' : 'muted'));
    }
    if (account.mute) {
      tags.append(pill(sanctionText('mute', account.mute), account.mute.active ? 'mute' : 'muted'));
    }

    const head = el('div', { className: 'acm__head' }, [
      avatar,
      idBox,
      el('span', { className: 'acm__mail', text: account.email }),
      tags,
    ]);

    const meta = el('div', { className: 'acm__meta' });
    meta.append(
      el('span', { text: `注册 ${formatDateTime(Date.parse(account.createdAt))}` }),
      el('span', {
        text: account.lastLoginAt
          ? `最后登录 ${formatDateTime(Date.parse(account.lastLoginAt))}`
          : '从没登录过',
      }),
    );
    if (account.grantedBadges.length > 0) {
      const chips = el('span', { className: 'acm__metabadges' });
      for (const badge of account.grantedBadges) {
        const chip = el('span', {
          className: `acm__minibadge${badge.archived ? ' is-archived' : ''}`,
          text: `${badge.emoji ? `${badge.emoji} ` : ''}${badge.label}`,
          attrs: { title: badge.hint },
        });
        chip.style.setProperty('--chip', badge.color);
        chips.append(chip);
      }
      meta.append(chips);
    }

    const ops = el('div', { className: 'acm__ops' });
    ops.append(
      toggleButton(account, 'ban', account.ban?.active ? '解除封禁' : '封禁', account.can.ban),
      toggleButton(account, 'mute', account.mute?.active ? '解除禁言' : '禁言', account.can.mute),
      toggleButton(account, 'role', '角色', account.can.role),
    );
    if (isOwner()) {
      ops.append(toggleButton(account, 'badge', '徽章', account.can.grantBadge));
    }

    node.append(head, meta, ops);

    if (openPanel && openPanel.id === account.id) {
      node.append(renderPanel(account, openPanel.kind));
    }
    return node;
  }

  function toggleButton(
    account: AdminAccount,
    kind: PanelKind,
    label: string,
    enabled: boolean,
  ): HTMLButtonElement {
    const active = openPanel?.id === account.id && openPanel.kind === kind;
    const node = button({
      className: `admin-btn admin-btn--ghost${active ? ' is-active' : ''}`,
      text: label,
      disabled: !enabled,
      title: enabled ? undefined : disabledHint(account, kind),
      onClick: () => {
        openPanel = active ? null : { id: account.id, kind };
        render();
      },
    });
    return node;
  }

  /** 按钮为什么点不动——比灰着不给理由强。 */
  function disabledHint(account: AdminAccount, kind: PanelKind): string {
    if (kind === 'role' && !account.can.role) return '不能修改自己的角色，也不能动站长的角色';
    if ((kind === 'ban' || kind === 'mute') && !account.can.ban) {
      return '不能封禁/禁言自己，也不能动站长';
    }
    if (kind === 'badge') return '徽章由站长统一管理';
    return '';
  }

  function renderPanel(account: AdminAccount, kind: PanelKind): HTMLElement {
    if (kind === 'ban') return renderSanctionPanel(account, 'ban');
    if (kind === 'mute') return renderSanctionPanel(account, 'mute');
    if (kind === 'role') return renderRolePanel(account);
    return renderBadgePanel(account);
  }

  /* 封禁 / 禁言 ---------------------------------------------------------- */

  function renderSanctionPanel(account: AdminAccount, kind: 'ban' | 'mute'): HTMLElement {
    const verb = kind === 'ban' ? '封禁' : '禁言';
    const current = kind === 'ban' ? account.ban : account.mute;
    const box = el('div', { className: 'acm__panel' });

    if (current) {
      box.append(
        el('p', {
          className: `acm__panelnote${current.active ? '' : ' is-expired'}`,
          text: current.active
            ? `当前：${sanctionText(kind, current)}（${current.by} 于 ${formatDateTime(Date.parse(current.at))} 执行${current.reason ? `，原因：${current.reason}` : ''}）`
            : `上一次：${sanctionText(kind, current)}（已过期）`,
        }),
      );
    }

    let days = 7;
    const durations = el('div', { className: 'acm__durations' });
    const durationButtons: HTMLButtonElement[] = [];
    for (const option of DURATIONS) {
      const node = button({
        className: `admin-btn admin-btn--ghost${option.days === days ? ' is-active' : ''}`,
        text: option.label,
        onClick: () => {
          days = option.days;
          for (const item of durationButtons) item.classList.toggle('is-active', item === node);
        },
      });
      durationButtons.push(node);
      durations.append(node);
    }

    const reason = el('input', {
      className: 'admin-input',
      attrs: {
        type: 'text',
        maxlength: '100',
        placeholder: `原因（会显示给被${verb}的人，可留空）`,
        'aria-label': `${verb}原因`,
        value: drafts.get(`${account.id}:${kind}`) ?? '',
      },
    });
    reason.addEventListener('input', () => {
      drafts.set(`${account.id}:${kind}`, reason.value);
    });

    const submit = button({
      className: 'admin-btn admin-btn--primary',
      text: current?.active ? `改判${verb}` : `确认${verb}`,
      onClick: () => {
        if (busy) return;
        void (async () => {
          if (days === 0) {
            // 永久是不可逆的方向，多问一句——但仍然是行内确认，不弹窗。
            if (!window.confirm(`确定要永久${verb}「${account.nickname}」吗？`)) return;
          }
          const call = kind === 'ban' ? source.ban : source.mute;
          await afterWrite(await call(account.id, days, reason.value.trim()), `已${verb}「${account.nickname}」。`);
        })();
      },
    });

    const actions = el('div', { className: 'acm__panelfoot' }, [submit]);
    if (current?.active || (kind === 'ban' && account.legacyDisabled)) {
      actions.append(
        button({
          className: 'admin-btn',
          text: `解除${verb}`,
          onClick: () => {
            if (busy) return;
            void (async () => {
              const call = kind === 'ban' ? source.unban : source.unmute;
              await afterWrite(await call(account.id), `已解除${verb}。`);
            })();
          },
        }),
      );
    }

    box.append(
      el('p', { className: 'acm__hint', text: `${verb}时长` }),
      durations,
      el('p', { className: 'acm__hint' }),
      reason,
      actions,
    );
    return box;
  }

  /* 角色 ---------------------------------------------------------------- */

  function renderRolePanel(account: AdminAccount): HTMLElement {
    const box = el('div', { className: 'acm__panel' });
    box.append(
      el('p', {
        className: 'acm__hint',
        text: '站长：全部权限（内容与徽章）。管理员：能管账号、审核内容，但不能发布。',
      }),
    );

    const row = el('div', { className: 'acm__durations' });
    for (const role of ['user', 'admin', 'owner'] as const) {
      const allowed =
        role === 'owner' ? account.can.grantOwner : account.can.role;
      row.append(
        button({
          className: `admin-btn admin-btn--ghost${account.role === role ? ' is-active' : ''}`,
          text: ROLE_LABEL[role],
          disabled: !allowed || account.role === role,
          title: allowed ? undefined : '只有站长能把别人设为站长',
          onClick: () => {
            if (busy) return;
            void (async () => {
              await afterWrite(
                await source.setRole(account.id, role),
                `「${account.nickname}」现在是${ROLE_LABEL[role]}。`,
              );
            })();
          },
        }),
      );
    }
    box.append(row);
    return box;
  }

  /* 徽章 ---------------------------------------------------------------- */

  function renderBadgePanel(account: AdminAccount): HTMLElement {
    const box = el('div', { className: 'acm__panel' });
    const chips = el('div', { className: 'acm__chips' });
    box.append(
      el('p', { className: 'acm__hint', text: '点灰色徽章授予，点已获得的徽章撤销。' }),
      chips,
    );

    const paint = (): void => {
      chips.replaceChildren();
      if (!catalog) {
        chips.append(el('span', { className: 'acm__hint', text: '正在读取徽章目录…' }));
        return;
      }
      if (catalog.badges.length === 0 && catalog.archived.length === 0) {
        chips.append(
          el('span', { className: 'acm__hint', text: '还没有定义任何徽章——先去「徽章」里建一枚。' }),
        );
        return;
      }

      const granted = new Set(account.grantedBadges.map((badge) => badge.badgeId));
      for (const badge of catalog.badges) {
        chips.append(badgeChip(badge, granted.has(badge.id), account));
      }
      // 已下架的目录项：他仍然持有，所以仍然显示（可以撤销，不能再授予）。
      for (const badge of catalog.archived) {
        if (!granted.has(badge.id)) continue;
        chips.append(badgeChip(badge, true, account, true));
      }
    };

    if (catalog) {
      paint();
    } else {
      paint();
      void (async () => {
        const result = await source.catalog();
        if (closed) return;
        if (!result.ok) {
          chips.replaceChildren(el('span', { className: 'acm__hint', text: result.message }));
          return;
        }
        catalog = { badges: result.data.badges, archived: result.data.archived };
        paint();
      })();
    }

    return box;
  }

  function badgeChip(
    badge: { id: string; label: string; color: string; emoji: string; hint: string },
    granted: boolean,
    account: AdminAccount,
    archived = false,
  ): HTMLButtonElement {
    const node = el('button', {
      className: `acm__chip${granted ? ' is-on' : ''}${archived ? ' is-archived' : ''}`,
      attrs: { type: 'button', title: archived ? '这枚徽章已下架，点一下可撤销' : badge.hint },
    });
    node.style.setProperty('--chip', badge.color);
    node.append(
      el('span', { className: 'acm__chip-dot' }),
      el('span', { text: `${badge.emoji ? `${badge.emoji} ` : ''}${badge.label}` }),
    );
    if (granted) node.append(el('span', { className: 'acm__chip-x', text: '×' }));
    node.addEventListener('click', () => {
      if (busy) return;
      void (async () => {
        const result = granted
          ? await source.revoke(account.id, badge.id)
          : await source.grant(account.id, badge.id);
        await afterWrite(
          result,
          granted ? `已撤销「${badge.label}」。` : `已授予「${badge.label}」。`,
        );
      })();
    });
    return node;
  }

  /* 交互 ---------------------------------------------------------------- */

  search.addEventListener('input', () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.q = search.value.trim();
      state.page = 1;
      void load();
    }, SEARCH_DEBOUNCE_MS);
  });

  roleSelect.addEventListener('change', () => {
    state.role = roleSelect.value as AccountRole | 'all';
    state.page = 1;
    void load();
  });

  stateSelect.addEventListener('change', () => {
    state.state = stateSelect.value as StateFilter;
    state.page = 1;
    void load();
  });

  void load();

  return {
    element: root,
    dispose: () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      if (statusTimer) window.clearTimeout(statusTimer);
    },
  };
}

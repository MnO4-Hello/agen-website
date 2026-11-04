/**
 * 后台「设置」：站点形态开关（`full` / `display` / `maintenance`）。
 *
 * 这一页只做一件事，但它比其它页危险得多：**点一下就能让整站对外关闭**。所以：
 *
 *   · 三张卡先说清各自的影响范围，再让人点（不是点完了才知道发生了什么）；
 *   · 切到「备案中」要**确认两次**——它是唯一「对外立刻可见、且可能正在被审核员看」的操作，
 *     多一次点击极便宜；
 *   · 常驻一行「接口立即生效、页面刷新后生效」——这两件事不一样，不写清楚会一直有人问
 *     「为什么我切了导航还在」。
 *
 * 没有弹窗组件（全项目一致）：确认走 `window.confirm`，反馈走底部那行 `role="status"`。
 * 也没有轮询：模式是运维级操作，不需要秒级同步，一个「重新读取」按钮就够了。
 */

import type { SiteModeSnapshot } from '../api';
import { liveSiteModeSource, type SiteModeSource } from '../site-source';
import { button, el, formatDateTime, icon } from '../ui';
import type { AdminView } from './view';

/** 三档的静态说明。`impact` 是「点了会发生什么」，比抽象的模式名有用。 */
const MODE_CARDS = [
  {
    mode: 'full',
    label: '完整站点',
    note: '博客、留言板、注册登录、公开主页全部开放。',
    impact: '开通：博客 / 留言板 / 账号与公开主页',
  },
  {
    mode: 'display',
    label: '展示站',
    note: '只剩首页、作品、关于我。社区类接口一律 404。',
    impact: '关闭：博客 / 留言板 / 账号与公开主页',
  },
  {
    mode: 'maintenance',
    label: '备案中',
    note: '访客只看到「备案中」提示页，接口全部 503。',
    impact: '关闭：站点全部页面与接口（管理后台除外）',
  },
] as const;

type ModeCard = (typeof MODE_CARDS)[number];

function labelOf(mode: string): string {
  return MODE_CARDS.find((card) => card.mode === mode)?.label ?? mode;
}

const SOURCE_TEXT: Record<SiteModeSnapshot['source'], string> = {
  file: '后台设置',
  env: '环境变量',
  fallback: '读取失败，已回退',
};

/** 成功的提示 4 秒淡出，错误常驻——与其它视图一致。 */
const STATUS_FADE_MS = 4000;

export function createSettingsView(source: SiteModeSource = liveSiteModeSource): AdminView {
  let closed = false;
  let busy = false;
  let statusTimer = 0;
  let snapshot: SiteModeSnapshot | null = null;

  const root = el('div', { className: 'stg' });
  const content = el('div', { className: 'stg__content' });
  const status = el('p', {
    className: 'stg__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  root.append(content, status);

  function setStatus(text: string, tone: 'ok' | 'error' = 'ok'): void {
    if (closed) return;
    window.clearTimeout(statusTimer);
    status.textContent = text;
    status.classList.toggle('is-ok', tone === 'ok');
    status.classList.toggle('is-error', tone === 'error');
    if (tone === 'ok') {
      statusTimer = window.setTimeout(() => {
        if (closed) return;
        status.textContent = '';
        status.classList.remove('is-ok');
      }, STATUS_FADE_MS);
    }
  }

  /* 顶部信息条 ---------------------------------------------------------- */

  function buildBar(site: SiteModeSnapshot): HTMLElement {
    let meta: string;
    if (site.source === 'file' && site.updatedAt) {
      const when = Number.isFinite(Date.parse(site.updatedAt))
        ? formatDateTime(Date.parse(site.updatedAt))
        : site.updatedAt;
      meta = `最后由 ${site.updatedBy || '未知'} 于 ${when} 切换`;
    } else if (site.source === 'env') {
      meta = `来自 .env 的 SITE_MODE=${site.envMode}，后台还没切过`;
    } else {
      meta = '存储文件读不出来，已回退到最严格的一档';
    }

    return el('section', { className: 'stg__bar' }, [
      el('span', { className: 'stg__bar-title', text: `当前生效：${labelOf(site.mode)}` }),
      el('span', { className: 'stg__src', text: SOURCE_TEXT[site.source] }),
      el('span', { className: 'stg__meta', text: meta }),
    ]);
  }

  /* 卡片 ---------------------------------------------------------------- */

  function choose(next: ModeCard['mode']): void {
    if (!snapshot || busy) return;
    const current = snapshot.mode;
    if (next === current) return;
    if (!confirmSwitch(next, current)) return;
    void commit(next);
  }

  function buildCards(site: SiteModeSnapshot): HTMLElement {
    const grid = el('div', { className: 'stg__seg' });
    for (const card of MODE_CARDS) {
      const active = card.mode === site.mode;
      const node = el('button', {
        className: `stg__segitem${active ? ' is-active' : ''}`,
        attrs: {
          type: 'button',
          'aria-pressed': active ? 'true' : 'false',
          disabled: busy ? true : null,
          // 危险档给个视觉提示：它和另外两档不是一个量级的操作。
          'data-danger': card.mode === 'maintenance' ? 'true' : null,
        },
      });
      node.append(
        el('span', { className: 'stg__segitem-label', text: card.label }),
        el('span', { className: 'stg__segitem-note', text: card.note }),
        el('span', { className: 'stg__segitem-impact', text: card.impact }),
      );
      if (!active) node.addEventListener('click', () => choose(card.mode));
      grid.append(node);
    }
    return grid;
  }

  /* 整页 ---------------------------------------------------------------- */

  function render(): void {
    const site = snapshot;
    if (!site) return;

    const section = el('section', { className: 'stg__section' }, [buildBar(site)]);

    if (site.corrupt) {
      section.append(
        el('div', { className: 'stg__warn' }, [
          icon('shield', 16),
          el('div', {}, [
            el('p', {
              className: 'stg__warn-title',
              text: '存储文件读不出来，当前按「展示站」运行',
            }),
            el('p', {
              className: 'stg__warn-note',
              text:
                'apps/api/data/site-mode.json 不是合法配置（或读取失败）。' +
                '在这里点任意一档就会覆盖它，旧文件会自动留一份 .bak。',
            }),
          ]),
        ]),
      );
    }

    section.append(
      el('p', { className: 'stg__hint', text: '选一档立即写入磁盘。接口立刻生效；已经打开的前台页面需要刷新。' }),
      buildCards(site),
    );

    const actions = el('div', { className: 'stg__actions' }, [
      button({
        className: 'admin-btn',
        icon: 'refresh',
        text: '重新读取',
        disabled: busy,
        onClick: () => void load(true),
      }),
      el('span', {
        className: 'stg__file',
        text: '落盘位置：apps/api/data/site-mode.json（已加入 .gitignore）',
      }),
    ]);
    section.append(actions);

    if (site.mode === 'maintenance') {
      section.append(
        el('p', {
          className: 'stg__danger',
          text: '站点处于「备案中」：访客打开任何页面都只看到提示页。管理后台仍然可用，随时可以在这里切回来。',
        }),
      );
    }

    content.replaceChildren(section);
  }

  /** 确认文案。返回 true 才真的写。 */
  function confirmSwitch(next: ModeCard['mode'], current: string): boolean {
    if (next === 'maintenance') {
      const first = window.confirm(
        '切到「备案中」后：\n\n' +
          '· 访客打开站点只会看到「备案中」提示页\n' +
          '· 除健康检查与后台接口外，全部返回 503\n' +
          '· 管理后台仍然可用，可以随时切回来\n\n' +
          '继续吗？',
      );
      if (!first) return false;
      // 第二道：这是唯一对外立刻可见、且可能正被审核员看着的操作。
      return window.confirm('再确认一次：这会让站点对访客立刻不可用。\n\n确定现在就关吗？');
    }

    if (current === 'maintenance') {
      return window.confirm(
        `离开「备案中」，站点会立刻恢复为「${labelOf(next)}」。\n\n` +
          '提醒：个人备案过审后的形态是「展示站」。如果你还在审核期，别开成完整站点。\n\n继续吗？',
      );
    }

    if (next === 'full') {
      return window.confirm(
        '切到「完整站点」会重新开放博客、留言板、注册登录与公开主页的接口。\n\n' +
          '如果这个站正处于个人备案状态，开放社区属于违规，核查发现会被注销备案。\n\n继续吗？',
      );
    }

    return window.confirm(
      '切到「展示站」后，博客、留言板、注册登录、公开主页的接口会立刻返回 404。\n\n' +
        '已有的帖子和留言数据不会被删除，切回来就都回来了。\n\n继续吗？',
    );
  }

  async function commit(mode: ModeCard['mode']): Promise<void> {
    busy = true;
    render();
    setStatus('正在写入…');

    const result = await source.write(mode);
    if (closed) return;
    busy = false;

    if (!result.ok) {
      // 后端写盘失败时会明确说「模式没有改变」，这里照原样显示，不做二次解释。
      render();
      setStatus(result.message, 'error');
      return;
    }

    snapshot = result.data.site;
    render();
    setStatus(
      result.data.changed
        ? `已切换到「${labelOf(result.data.site.mode)}」。前台访客刷新页面后可见。`
        : `已经是「${labelOf(result.data.site.mode)}」，没有变化。`,
    );
  }

  async function load(manual = false): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    if (manual) setStatus('正在读取…');

    const result = await source.read();
    if (closed) return;
    busy = false;

    if (!result.ok) {
      content.replaceChildren(
        el('p', { className: 'stg__empty', text: `读不到站点形态：${result.message}` }),
      );
      setStatus(result.message, 'error');
      return;
    }

    snapshot = result.data.site;
    render();
    if (manual) setStatus('已重新读取。');
  }

  content.replaceChildren(el('p', { className: 'stg__empty', text: '正在读取站点形态…' }));
  void load();

  return {
    element: root,
    dispose: () => {
      closed = true;
      window.clearTimeout(statusTimer);
      content.replaceChildren();
    },
  };
}

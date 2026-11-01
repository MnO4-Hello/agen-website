/**
 * 后台「徽章」：站长定义要发哪些徽章（只有站长能改，见 `admin/guard.ts` 的 `OWNER_ONLY`）。
 *
 * 三件需要说清楚的事，界面上都要写出来，否则会有人误会：
 *
 *   1. **「下架」不是删除**。已授予的人不会掉徽章，只是它不再出现在可授予列表里。
 *      所以按钮写「下架」而不是「删除」，确认文案也要带上「N 人仍然保留」。
 *   2. **徽章名称允许用「官方认证」这类词**。与用户自建徽章不同——那套保留字挡的是
 *      「用户自封官方」，站长本来就该能发一枚真的官方徽章。
 *   3. **这里只管目录，授予在某个人身上**（账户视图 → 徽章面板）。两个入口共用同一份
 *      目录，`account-source.ts` 的 `catalog()`。
 */

import type { AdminBadge, BadgeDraft } from '../api';
import { button, el, formatDateTime } from '../ui';
import type { AccountSource } from './account-source';
import type { AdminView } from './view';
import '../admin-accounts.css';

const DEFAULT_COLOR = '#4c6f8a';

interface FormState {
  mode: 'create' | 'edit';
  id: string;
  draft: BadgeDraft;
}

function emptyDraft(): BadgeDraft {
  return { label: '', color: DEFAULT_COLOR, emoji: '', hint: '' };
}

export function createBadgeCatalogView(source: AccountSource): AdminView {
  let closed = false;
  let busy = false;
  let form: FormState | null = null;

  const catalog = { badges: [] as AdminBadge[], archived: [] as AdminBadge[] };

  const root = el('div', { className: 'bdg' });

  const count = el('span', { className: 'bdg__count', text: '' });
  const newButton = button({
    className: 'admin-btn admin-btn--primary',
    text: '新建徽章',
    onClick: () => {
      form = { mode: 'create', id: '', draft: emptyDraft() };
      render();
    },
  });
  const top = el('div', { className: 'bdg__top' }, [count, newButton]);

  const statusLine = el('p', {
    className: 'bdg__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  statusLine.hidden = true;

  const formSlot = el('div', { className: 'bdg__formslot' });
  const list = el('ul', { className: 'bdg__list' });
  const archivedBox = el('div', { className: 'bdg__archived' });

  root.append(top, statusLine, formSlot, list, archivedBox);

  function setStatus(text: string, tone: 'info' | 'ok' | 'error' = 'info'): void {
    statusLine.textContent = text;
    statusLine.hidden = !text;
    statusLine.classList.toggle('is-error', tone === 'error');
    statusLine.classList.toggle('is-ok', tone === 'ok');
  }

  async function load(): Promise<void> {
    const result = await source.catalog();
    if (closed) return;
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    catalog.badges = result.data.badges;
    catalog.archived = result.data.archived;
    render();
  }

  async function afterWrite(result: { ok: true } | { ok: false; message: string }, okText: string) {
    if (!result.ok) {
      setStatus(result.message, 'error');
      return;
    }
    form = null;
    setStatus(okText, 'ok');
    await load();
  }

  /* 渲染 ---------------------------------------------------------------- */

  function render(): void {
    count.textContent = `共 ${catalog.badges.length} 枚${catalog.archived.length > 0 ? `（另有 ${catalog.archived.length} 枚已下架）` : ''}`;
    renderForm();
    renderList();
    renderArchived();
  }

  /** 徽章预览：后台看到的就和前台长出来的一样（描边 + 色点 + 图标）。 */
  function previewNode(draft: BadgeDraft): HTMLElement {
    const node = el('span', { className: 'acm__chip is-on' });
    node.style.setProperty('--chip', draft.color);
    node.append(
      el('span', { className: 'acm__chip-dot' }),
      el('span', { text: `${draft.emoji ? `${draft.emoji} ` : ''}${draft.label || '（没名字）'}` }),
    );
    return node;
  }

  function renderForm(): void {
    formSlot.replaceChildren();
    if (!form) return;
    const draft = form.draft;

    // 预览放在最前面定义：下面每个输入框的监听都要用它。
    const preview = el('span', { className: 'bdg__preview' }, [previewNode(draft)]);
    const repaint = (): void => {
      preview.replaceChildren(previewNode(draft));
    };

    const emoji = el('input', {
      className: 'admin-input bdg__emoji',
      attrs: { type: 'text', maxlength: '8', placeholder: '🏅', 'aria-label': '图标' },
    });
    emoji.value = draft.emoji;
    emoji.addEventListener('input', () => {
      draft.emoji = emoji.value;
      repaint();
    });

    const label = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', maxlength: '12', placeholder: '徽章名称（≤12 字）', 'aria-label': '名称' },
    });
    label.value = draft.label;
    label.addEventListener('input', () => {
      draft.label = label.value;
      repaint();
    });

    const color = el('input', {
      className: 'bdg__color',
      attrs: { type: 'color', 'aria-label': '颜色' },
    });
    color.value = draft.color;
    color.addEventListener('input', () => {
      draft.color = color.value;
      repaint();
    });

    const hint = el('input', {
      className: 'admin-input',
      attrs: { type: 'text', maxlength: '40', placeholder: '悬停提示，默认「由站长授予」', 'aria-label': '提示语' },
    });
    hint.value = draft.hint;
    hint.addEventListener('input', () => {
      draft.hint = hint.value;
    });

    const save = button({
      className: 'admin-btn admin-btn--primary',
      text: form.mode === 'create' ? '添加' : '保存',
      onClick: () => {
        if (busy) return;
        if (!draft.label.trim()) {
          setStatus('徽章要有名字。', 'error');
          return;
        }
        void (async () => {
          busy = true;
          const body: BadgeDraft = {
            label: draft.label.trim(),
            color: draft.color,
            emoji: draft.emoji.trim(),
            hint: draft.hint.trim(),
          };
          const result =
            form?.mode === 'edit'
              ? await source.updateBadge(form.id, body)
              : await source.createBadge(body);
          busy = false;
          await afterWrite(result, form?.mode === 'edit' ? '已保存。' : '已添加。');
        })();
      },
    });

    const cancel = button({
      className: 'admin-btn admin-btn--ghost',
      text: '取消',
      onClick: () => {
        form = null;
        render();
      },
    });

    formSlot.append(
      el('div', { className: 'bdg__form' }, [
        el('div', { className: 'bdg__formrow' }, [emoji, label, color, hint]),
        el('div', { className: 'bdg__formfoot' }, [preview, save, cancel]),
      ]),
    );
  }

  function renderList(): void {
    list.replaceChildren();
    if (catalog.badges.length === 0) {
      list.append(
        el('li', {
          className: 'admin-empty',
          text: '还没有徽章。建一枚之后，就能在「账户」里发给具体的人。',
        }),
      );
      return;
    }

    for (const badge of catalog.badges) {
      const node = el('li', { className: 'bdg__row' });

      const chip = el('span', { className: 'acm__chip is-on' });
      chip.style.setProperty('--chip', badge.color);
      chip.append(
        el('span', { className: 'acm__chip-dot' }),
        el('span', { text: `${badge.emoji ? `${badge.emoji} ` : ''}${badge.label}` }),
      );

      const meta = el('span', {
        className: 'bdg__meta',
        text: `${badge.grantCount} 人持有 · 悬停提示「${badge.hint}」· 建于 ${formatDateTime(
          Date.parse(badge.createdAt),
        )}`,
      });

      const ops = el('div', { className: 'bdg__ops' }, [
        button({
          className: 'admin-btn admin-btn--ghost',
          text: '编辑',
          onClick: () => {
            form = {
              mode: 'edit',
              id: badge.id,
              draft: {
                label: badge.label,
                color: badge.color,
                emoji: badge.emoji,
                hint: badge.hint,
              },
            };
            render();
            formSlot.scrollIntoView({ block: 'nearest' });
          },
        }),
        button({
          className: 'admin-btn admin-btn--ghost',
          text: '下架',
          onClick: () => {
            if (busy) return;
            const keep = badge.grantCount > 0 ? `已授予的 ${badge.grantCount} 位用户不会被收回。` : '';
            if (!window.confirm(`下架「${badge.label}」？${keep}`)) return;
            void (async () => {
              busy = true;
              const result = await source.archiveBadge(badge.id);
              busy = false;
              await afterWrite(result, `已下架「${badge.label}」。`);
            })();
          },
        }),
      ]);

      node.append(chip, meta, ops);
      list.append(node);
    }
  }

  function renderArchived(): void {
    archivedBox.replaceChildren();
    if (catalog.archived.length === 0) return;

    archivedBox.append(el('p', { className: 'bdg__subtitle', text: '已下架' }));
    const listNode = el('ul', { className: 'bdg__list' });
    for (const badge of catalog.archived) {
      const node = el('li', { className: 'bdg__row is-archived' });
      const chip = el('span', { className: 'acm__chip' });
      chip.style.setProperty('--chip', badge.color);
      chip.append(
        el('span', { className: 'acm__chip-dot' }),
        el('span', { text: `${badge.emoji ? `${badge.emoji} ` : ''}${badge.label}` }),
      );
      node.append(
        chip,
        el('span', {
          className: 'bdg__meta',
          text: `${badge.grantCount} 人仍持有 · 不再出现在可授予列表里`,
        }),
        el('div', { className: 'bdg__ops' }, [
          button({
            className: 'admin-btn admin-btn--ghost',
            text: '恢复',
            onClick: () => {
              if (busy) return;
              void (async () => {
                busy = true;
                const result = await source.restoreBadge(badge.id);
                busy = false;
                await afterWrite(result, `已恢复「${badge.label}」。`);
              })();
            },
          }),
        ]),
      );
      listNode.append(node);
    }
    archivedBox.append(listNode);
  }

  void load();

  return {
    element: root,
    dispose: () => {
      closed = true;
    },
  };
}

/**
 * 后台「分类」面板。
 *
 * 三条与后端约定的交互，都能在错误文案里看出原因：
 *   · **重名 → 409**：唯一性按 `normalizeKey(name)` 判（全半角、大小写、多余空格都归一）；
 *   · **有帖子引用 → 409**：此时**原样显示服务端那句**（带具体篇数），不自己拼一句更模糊的；
 *   · **只剩一个 → 409**：发帖必须选分类，空表会让编辑器的下拉变成空壳。
 *
 * 排序走「全量 ids 置换」——只发改动的那两条，前端与服务端很容易对不上。
 */

import type { AdminCategory } from '../api';
import { button, el } from '../ui';
import type { PostsSource } from './post-source';

export interface CategoryPanelOptions {
  source: PostsSource;
  /** 分类有增删改之后通知外层（帖子编辑器的下拉要重新拿）。 */
  onChanged: () => void;
  setStatus: (text: string, tone?: 'info' | 'ok' | 'error') => void;
}

export interface CategoryPanelHandle {
  element: HTMLElement;
  reload(): Promise<void>;
  dispose(): void;
}

export function createCategoryPanel(options: CategoryPanelOptions): CategoryPanelHandle {
  let closed = false;
  let busy = false;
  let categories: AdminCategory[] = [];

  const root = el('div', { className: 'bps-cats' });

  const newRow = el('div', { className: 'bps-cats__new' });
  const nameInput = el('input', {
    className: 'admin-input',
    attrs: { type: 'text', placeholder: '新分类名，比如「折腾」', maxlength: 20 },
  });
  const addButton = button({
    className: 'admin-btn admin-btn--primary',
    text: '添加',
    icon: 'plus',
    onClick: () => void add(),
  });
  newRow.append(nameInput, addButton);

  const hint = el('p', {
    className: 'bps-cats__hint',
    text: '唯一性按名称判（忽略大小写与全半角）。还有帖子引用的分类不能删，先把帖子改到别的分类。',
  });

  const list = el('ul', { className: 'bps-cats__list' });
  root.append(newRow, hint, list);

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    }
  });

  async function add(): Promise<void> {
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) {
      options.setStatus('先写个分类名。', 'error');
      return;
    }
    busy = true;
    const result = await options.source.createCategory(name);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      return;
    }
    nameInput.value = '';
    options.setStatus('分类添加好了。', 'ok');
    await reload();
    options.onChanged();
  }

  async function rename(category: AdminCategory, input: HTMLInputElement): Promise<void> {
    if (busy) return;
    const name = input.value.trim();
    if (!name || name === category.name) return;
    busy = true;
    const result = await options.source.updateCategory(category.id, name);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      input.value = category.name;
      return;
    }
    options.setStatus('分类改名成功。', 'ok');
    await reload();
    options.onChanged();
  }

  async function remove(category: AdminCategory): Promise<void> {
    if (busy) return;
    const ok = window.confirm(
      `删除分类「${category.name}」？\n\n还有帖子引用它时会失败——这是有意的，避免帖子变成孤儿。`,
    );
    if (!ok) return;
    busy = true;
    const result = await options.source.removeCategory(category.id);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      // 原样显示服务端的说明：它带着「还有 N 篇」这个具体数字。
      options.setStatus(result.message, 'error');
      return;
    }
    options.setStatus('分类删除了。', 'ok');
    await reload();
    options.onChanged();
  }

  async function move(category: AdminCategory, delta: number): Promise<void> {
    if (busy) return;
    const index = categories.findIndex((item) => item.id === category.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= categories.length) return;

    const ids = categories.map((item) => item.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);

    busy = true;
    const result = await options.source.reorderCategories(ids);
    busy = false;
    if (closed) return;
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      await reload();
      return;
    }
    categories = result.data.categories;
    render();
    options.onChanged();
  }

  function render(): void {
    if (categories.length === 0) {
      list.replaceChildren(el('li', { className: 'bps-cats__empty', text: '一个分类都还没有。' }));
      return;
    }

    list.replaceChildren(
      ...categories.map((category, index) => {
        const input = el('input', {
          className: 'admin-input bps-cats__name',
          attrs: { type: 'text', maxlength: 20, 'aria-label': `分类名 ${category.name}` },
        });
        input.value = category.name;

        const save = button({
          className: 'admin-btn bps-cats__save',
          text: '保存',
          disabled: true,
          onClick: () => void rename(category, input),
        });

        input.addEventListener('input', () => {
          save.disabled = input.value.trim() === category.name || input.value.trim() === '';
        });
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void rename(category, input);
          }
        });

        const up = button({
          className: 'admin-iconbtn',
          title: '上移',
          text: '↑',
          disabled: index === 0,
          onClick: () => void move(category, -1),
        });
        const down = button({
          className: 'admin-iconbtn',
          title: '下移',
          text: '↓',
          disabled: index === categories.length - 1,
          onClick: () => void move(category, 1),
        });
        const removeButton = button({
          className: 'admin-iconbtn admin-iconbtn--danger',
          title: '删除分类',
          icon: 'trash',
          onClick: () => void remove(category),
        });

        const ops = el('div', { className: 'bps-cats__ops' }, [up, down, save, removeButton]);

        return el('li', { className: 'bps-cats__row' }, [
          input,
          el('span', { className: 'bps-cats__count', text: `${category.count} 篇` }),
          el('code', { className: 'bps-cats__key', text: category.key }),
          ops,
        ]);
      }),
    );
  }

  async function reload(): Promise<void> {
    const result = await options.source.categories();
    if (closed) return;
    if (!result.ok) {
      options.setStatus(result.message, 'error');
      return;
    }
    categories = result.data.categories;
    render();
  }

  void reload();

  return {
    element: root,
    reload,
    dispose: () => {
      closed = true;
    },
  };
}

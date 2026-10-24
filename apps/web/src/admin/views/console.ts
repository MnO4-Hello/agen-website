/**
 * 控制台视图：把后端进程的输出实时铺在页面上。
 *
 * 数据是从 `EventSource`（SSE）来的，前端**只是观众**：这里没有「执行命令」的输入框。
 * 这是有意的——一个能执行任意命令的网页后台，一旦 cookie 被拿到就是直接提权；要看输出
 * 有日志就够了，要跑命令请去终端。
 *
 * 三个容易踩的点：
 *   1. **断线重连会重复推**：`EventSource` 自动重连时 URL 里的 `after` 是旧的，所以每次
 *      `open` 都要按 `lastId` 补一次快照，并按 id 单调去重。
 *   2. **暂停不是断开**：暂停时连接照旧收日志，只是不画；恢复时整块重绘，不丢行。
 *   3. **DOM 要跟着缓冲一起封顶**：内存里留 1200 条，屏幕上也要把最上面的行删掉，
 *      否则滚一天浏览器会卡。
 */

import {
  clearServerLogs,
  fetchLogs,
  openLogStream,
  type ApiResult,
  type LogEntry,
  type LogLevel,
  type LogSnapshot,
  type ServerStats,
} from '../api';
import { button, el, formatBytes, formatClock, formatUptime, icon } from '../ui';
import type { AdminView } from './view';

/** 内存与 DOM 都最多保留这么多行。 */
const MAX_ROWS = 1200;

type LevelFilter = 'all' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

const LEVEL_MIN: Record<LevelFilter, number> = {
  all: 0,
  info: LEVEL_RANK.info,
  warn: LEVEL_RANK.warn,
  error: LEVEL_RANK.error,
};

export interface ConsoleSource {
  snapshot: (after: number) => Promise<ApiResult<LogSnapshot>>;
  clear: () => Promise<ApiResult<unknown>>;
  subscribe: (
    after: number,
    handlers: {
      onLog: (entry: LogEntry) => void;
      onStats: (stats: ServerStats) => void;
      onState: (state: 'open' | 'error') => void;
    },
  ) => () => void;
}

const liveSource: ConsoleSource = {
  snapshot: (after) => fetchLogs(after, 500),
  clear: () => clearServerLogs(),
  subscribe: (after, handlers) => openLogStream(after, handlers),
};

export function createConsoleView(source: ConsoleSource = liveSource): AdminView {
  const entries: LogEntry[] = [];
  let lastId = 0;
  let paused = false;
  let pending = 0;
  let filter: LevelFilter = 'all';
  let query = '';
  let autoScroll = true;
  let closed = false;

  /* ---- 顶部仪表 ---- */

  const connText = el('span', { className: 'meter__value', text: '连接中…' });
  const connDot = el('span', { className: 'meter__dot' });
  const connMeter = el('div', { className: 'meter meter--conn' }, [
    el('span', { className: 'meter__label', text: '连接' }),
    el('span', { className: 'meter__value' }, [connDot, connText]),
  ]);

  const makeMeter = (label: string, initial: string): { node: HTMLElement; set: (value: string) => void } => {
    const value = el('span', { className: 'meter__value', text: initial });
    const node = el('div', { className: 'meter' }, [el('span', { className: 'meter__label', text: label }), value]);
    return { node, set: (next) => (value.textContent = next) };
  };

  const pidMeter = makeMeter('PID', '—');
  const uptimeMeter = makeMeter('已运行', '—');
  const memoryMeter = makeMeter('内存', '—');
  const nodeMeter = makeMeter('Node', '—');
  const bufferMeter = makeMeter('缓冲', '0 条');

  const meters = el('div', { className: 'console__meters' }, [
    connMeter,
    pidMeter.node,
    uptimeMeter.node,
    memoryMeter.node,
    nodeMeter.node,
    bufferMeter.node,
  ]);

  /* ---- 工具栏 ---- */

  const levelSelect = el('select', { className: 'admin-select', attrs: { 'aria-label': '日志级别' } });
  for (const [value, label] of [
    ['all', '全部级别'],
    ['info', '信息以上'],
    ['warn', '警告以上'],
    ['error', '仅错误'],
  ] as const) {
    levelSelect.append(el('option', { text: label, attrs: { value } }));
  }
  levelSelect.value = 'all';
  levelSelect.addEventListener('change', () => {
    filter = levelSelect.value as LevelFilter;
    renderAll();
  });

  const search = el('input', {
    className: 'admin-input admin-input--search',
    attrs: { type: 'search', placeholder: '过滤关键字…', 'aria-label': '过滤关键字' },
  });
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    renderAll();
  });

  const pauseButton = button({
    className: 'admin-btn',
    icon: 'pause',
    text: '暂停',
    title: '暂停刷新（连接不会断，日志继续收）',
    onClick: () => togglePause(),
  });

  const clearButton = button({
    className: 'admin-btn',
    icon: 'trash',
    text: '清空',
    title: '清空屏幕与服务端缓冲',
    onClick: () => clearAll(),
  });

  const autoToggle = el('input', { className: 'admin-check', attrs: { type: 'checkbox' } }) as HTMLInputElement;
  autoToggle.checked = true;
  autoToggle.addEventListener('change', () => {
    autoScroll = autoToggle.checked;
    if (autoScroll) scrollToBottom();
  });

  const autoLabel = el('label', { className: 'admin-check-label' }, [autoToggle, el('span', { text: '自动滚动' })]);

  const toolbar = el('div', { className: 'console__toolbar' }, [
    levelSelect,
    search,
    el('span', { className: 'console__spacer' }),
    autoLabel,
    pauseButton,
    clearButton,
  ]);

  /* ---- 屏幕 ---- */

  const lines = el('div', { className: 'console__lines' });
  const empty = el('div', { className: 'console__empty', text: '正在连接后端…' });
  const screen = el('div', { className: 'console__screen', attrs: { role: 'log' } }, [lines, empty]);

  const foot = el('p', {
    className: 'console__foot',
    text: '日志只保留在当前进程内存里（最近 1000 条），重启后端即清空。这里只读——要执行命令请用终端。',
  });

  const element = el('section', { className: 'console' }, [meters, toolbar, screen, foot]);

  /* ---- 渲染 ---- */

  function matches(entry: LogEntry): boolean {
    if (LEVEL_RANK[entry.level] < LEVEL_MIN[filter]) return false;
    if (!query) return true;
    return entry.text.toLowerCase().includes(query) || entry.level.includes(query);
  }

  function rowFor(entry: LogEntry): HTMLElement {
    return el('div', { className: `log log--${entry.level}` }, [
      el('span', { className: 'log__time', text: formatClock(entry.time) }),
      el('span', { className: 'log__level', text: entry.level }),
      el('span', { className: 'log__text', text: entry.text }),
    ]);
  }

  function updateEmpty(): void {
    if (lines.childElementCount > 0) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    if (entries.length > 0) {
      empty.textContent = paused ? '已暂停，恢复后显示新日志。' : '没有符合当前筛选条件的日志。';
    } else {
      empty.textContent = '暂时没有输出，等下一次请求或后端日志。';
    }
  }

  function scrollToBottom(): void {
    screen.scrollTop = screen.scrollHeight;
  }

  function renderAll(): void {
    lines.replaceChildren();
    for (const entry of entries) {
      if (matches(entry)) lines.append(rowFor(entry));
    }
    updateEmpty();
    if (autoScroll && !paused) scrollToBottom();
  }

  function appendRow(entry: LogEntry): void {
    if (!matches(entry)) return;
    lines.append(rowFor(entry));
    while (lines.childElementCount > MAX_ROWS) lines.firstElementChild?.remove();
    updateEmpty();
    if (autoScroll && !paused) scrollToBottom();
  }

  function remember(entry: LogEntry): void {
    if (entry.id <= lastId) return;
    lastId = entry.id;
    entries.push(entry);
    while (entries.length > MAX_ROWS) entries.shift();
  }

  function updatePauseButton(): void {
    pauseButton.replaceChildren(icon(paused ? 'play' : 'pause', 16));
    pauseButton.append(el('span', { text: paused ? `继续${pending > 0 ? `（${pending} 条）` : ''}` : '暂停' }));
    pauseButton.classList.toggle('is-active', paused);
  }

  function togglePause(): void {
    paused = !paused;
    if (!paused) {
      pending = 0;
      renderAll();
    }
    updatePauseButton();
  }

  function clearAll(): void {
    entries.length = 0;
    pending = 0;
    lines.replaceChildren();
    updateEmpty();
    bufferMeter.set('0 条');
    // 服务端也清掉：否则下次重连会把历史又推回来。
    void source.clear().then((result) => {
      if (!result.ok && result.status !== 401) {
        foot.textContent = `屏幕已清空，但服务端缓冲没清掉：${result.message}`;
      }
    });
  }

  function setConn(state: 'connecting' | 'open' | 'error'): void {
    connDot.className = `meter__dot${state === 'open' ? ' is-ok' : state === 'error' ? ' is-bad' : ' is-wait'} `;
    connText.textContent = state === 'open' ? '已连接' : state === 'error' ? '重连中…' : '连接中…';
    if (state === 'open') foot.textContent = '日志只保留在当前进程内存里（最近 1000 条），重启后端即清空。这里只读——要执行命令请用终端。';
  }

  function applyStats(stats: ServerStats): void {
    pidMeter.set(String(stats.pid));
    uptimeMeter.set(formatUptime(stats.uptimeSeconds));
    memoryMeter.set(`${formatBytes(stats.rssBytes)} / 堆 ${formatBytes(stats.heapUsedBytes)}`);
    nodeMeter.set(stats.node);
    bufferMeter.set(`${stats.logCount} 条`);
  }

  /* ---- 连接 ---- */

  setConn('connecting');

  const unsubscribe = source.subscribe(lastId, {
    onLog: (entry) => {
      if (closed) return;
      remember(entry);
      if (paused) {
        pending += 1;
        updatePauseButton();
        return;
      }
      appendRow(entry);
    },
    onStats: (stats) => {
      if (!closed) applyStats(stats);
    },
    onState: (state) => {
      if (closed) return;
      if (state === 'open') {
        setConn('open');
        // 补齐断线期间漏掉的（重复的会在 remember 里按 id 丢掉）。
        void source.snapshot(lastId).then((result) => {
          if (closed || !result.ok) return;
          for (const entry of result.data.logs) {
            const known = entry.id <= lastId;
            remember(entry);
            if (!known && !paused) appendRow(entry);
          }
          applyStats(result.data.stats);
          if (paused) updatePauseButton();
        });
        return;
      }
      setConn('error');
    },
  });

  void source.snapshot(0).then((result) => {
    if (closed) return;
    if (!result.ok) {
      empty.hidden = false;
      empty.textContent = result.message;
      return;
    }
    for (const entry of result.data.logs) remember(entry);
    applyStats(result.data.stats);
    renderAll();
  });

  screen.addEventListener('scroll', () => {
    // 手动往上翻时自动关掉「跟随底部」，否则新日志一来就把人拽回底部。
    const distance = screen.scrollHeight - screen.scrollTop - screen.clientHeight;
    if (distance > 48 && autoScroll) {
      autoScroll = false;
      autoToggle.checked = false;
    }
  });

  updatePauseButton();

  return {
    element,
    dispose: () => {
      closed = true;
      unsubscribe();
    },
  };
}

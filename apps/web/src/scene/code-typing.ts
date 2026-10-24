/**
 * 右栏「代码打字机」场景：一个像样的深色代码编辑器，逐字符、逐行地敲出一段
 * Hello World，敲完后**快速逐字退格删掉**，再换下一种语言，周而复始。
 *
 * 它是 `SkillSceneHandle` 契约下的一个场景（见 scene/skill-scene.ts），由
 * `sections/skills.ts` 的注册表按 id 惰性创建——所以这里只关心「怎么把字打出来」，
 * 不管卡片、命中与显隐时序。
 *
 * 设计要点：
 *   1. **无第三方高亮库**：每门语言一份 `LanguageSpec`（关键字表 + 注释族 + 引号），
 *      按行一遍扫描切出带颜色的 token；构造 / `play()` 时**一次性**把整段展开成
 *      逐字符的 `cells`，运行期不再分词。
 *   2. **增量渲染**：光标 `caret` 是行内唯一的锚点，新字符插在它前面；同色的连续
 *      字符直接拼到上一个文本节点的 `data` 上，退格也只在末尾 `slice`——每帧至多
 *      动一个节点，既不重建 DOM，也不读布局（和 image-compare 同一条纪律）。
 *   3. **reduced-motion 不整体早退**：照常建面板，只是把循环降级成「静态渲染一段」。
 *
 * 依赖方向：content/skills.ts（无依赖）← 本文件 ← sections/skills.ts。
 */

import type { CodeLanguage, CodeSnippet, SkillCardContent } from '../content/skills';
import type { SkillSceneHandle } from './skill-scene';
import { prefersReducedMotion } from './text-support';

/** 词法着色种类（对应 VS Code Dark+ 的几大配色）。 */
export type CodeTokenKind = 'kw' | 'str' | 'num' | 'fn' | 'typ' | 'com' | 'pun' | 'plain';

/** 一个着色片段。 */
interface CodeToken {
  readonly text: string;
  readonly kind: CodeTokenKind;
}

/** 展开到「单个字符」的单元，渲染时按 index 直接取用。 */
interface CodeChar {
  readonly ch: string;
  readonly kind: CodeTokenKind;
}

/** 一门语言的词法配置。 */
interface LanguageSpec {
  /** 关键字（命中即 `kw`）。 */
  readonly keywords: ReadonlySet<string>;
  /** 行注释前缀，如 `//`、`#`、`--`。 */
  readonly lineComment: string;
  /** 块注释对，如 `['/*', '*​/']`；没有就不配。 */
  readonly blockComment?: readonly [string, string];
  /** 字符串引号种类。 */
  readonly quotes: readonly string[];
  /** HTML 走单独的标签扫描分支。 */
  readonly html?: boolean;
}

export interface CodeTypingOptions {
  /** 挂载宿主：传 `.skills__frame--swarm`（继承 16:9 尺寸与 `--frame-radius`）。 */
  host: HTMLElement;
  /** 初始片段；一般留空，由 `play()` 从卡片内容里读。 */
  snippets?: readonly CodeSnippet[];
}

// -- 节奏 ---------------------------------------------------------------------

/** 每敲一个字符的间隔（ms）。 */
const TYPE_MS = 34;
/** 打完一段后停顿（ms）。 */
const HOLD_MS = 1100;
/** 退格每个字符的间隔（ms）——比输入快，才有「快速删除」的观感。 */
const DELETE_MS = 14;
/** 删空到下一门语言之间的停顿（ms）。 */
const GAP_MS = 260;

// -- 语言表 -------------------------------------------------------------------

const set = (...words: string[]): ReadonlySet<string> => new Set(words);

const SLASH_SPEC = (keywords: string[], quotes: readonly string[] = ['"', "'", '`']): LanguageSpec => ({
  keywords: set(...keywords),
  lineComment: '//',
  blockComment: ['/*', '*/'],
  quotes,
});

/**
 * 每门语言的词法配置。关键字不求全，够把 Hello World 里的词点亮、并让颜色层次
 * 丰富即可。
 */
const LANG_SPECS: Record<CodeLanguage, LanguageSpec> = {
  python: {
    keywords: set('def', 'return', 'import', 'from', 'as', 'if', 'else', 'elif', 'for', 'in', 'while', 'None', 'True', 'False', 'class', 'print', 'lambda', 'with', 'try', 'except'),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  javascript: SLASH_SPEC(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', '=>', 'new', 'this', 'true', 'false', 'null', 'class', 'import', 'export', 'console']),
  typescript: SLASH_SPEC(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', '=>', 'new', 'this', 'true', 'false', 'null', 'class', 'import', 'export', 'interface', 'type', 'string', 'number', 'boolean', 'console']),
  java: SLASH_SPEC(['public', 'static', 'void', 'class', 'final', 'new', 'return', 'if', 'else', 'for', 'while', 'int', 'String', 'System', 'true', 'false', 'null', 'private']),
  c: SLASH_SPEC(['int', 'void', 'return', 'if', 'else', 'for', 'while', 'char', 'const', 'struct', 'include', 'printf', 'unsigned', 'long', 'float', 'double'], ['"', "'"]),
  cpp: SLASH_SPEC(['int', 'void', 'return', 'if', 'else', 'for', 'while', 'char', 'const', 'class', 'struct', 'include', 'std', 'cout', 'endl', 'auto', 'using', 'namespace'], ['"', "'"]),
  csharp: SLASH_SPEC(['using', 'public', 'static', 'void', 'class', 'var', 'new', 'return', 'if', 'else', 'for', 'while', 'int', 'string', 'Console', 'true', 'false', 'null']),
  go: SLASH_SPEC(['package', 'import', 'func', 'return', 'var', 'const', 'if', 'else', 'for', 'range', 'type', 'struct', 'fmt', 'string', 'int', 'true', 'false', 'nil', 'Println'], ['"', '`']),
  rust: SLASH_SPEC(['fn', 'let', 'mut', 'return', 'if', 'else', 'for', 'while', 'struct', 'impl', 'use', 'pub', 'println', 'true', 'false', 'match', 'const'], ['"', "'"]),
  ruby: {
    keywords: set('def', 'end', 'return', 'if', 'else', 'elsif', 'for', 'while', 'do', 'class', 'module', 'puts', 'require', 'true', 'false', 'nil', 'print'),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  php: {
    keywords: set('function', 'return', 'if', 'else', 'foreach', 'as', 'while', 'class', 'echo', 'print', 'new', 'true', 'false', 'null', 'namespace', 'use', 'public'),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  swift: SLASH_SPEC(['func', 'let', 'var', 'return', 'if', 'else', 'for', 'in', 'while', 'class', 'struct', 'import', 'print', 'true', 'false', 'nil', 'String', 'Int'], ['"']),
  kotlin: SLASH_SPEC(['fun', 'val', 'var', 'return', 'if', 'else', 'for', 'in', 'while', 'class', 'import', 'println', 'true', 'false', 'null', 'String', 'Int'], ['"']),
  r: {
    keywords: set('function', 'return', 'if', 'else', 'for', 'while', 'in', 'print', 'cat', 'paste', 'TRUE', 'FALSE', 'NULL', 'library', 'library'),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  bash: {
    keywords: set('echo', 'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'function', 'return', 'export', 'local', 'printf'),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  lua: {
    keywords: set('function', 'end', 'return', 'if', 'then', 'else', 'elseif', 'for', 'do', 'while', 'local', 'print', 'true', 'false', 'nil', 'require'),
    lineComment: '--',
    quotes: ['"', "'"],
  },
  haskell: {
    keywords: set('main', 'let', 'in', 'where', 'do', 'return', 'if', 'then', 'else', 'module', 'import', 'putStrLn', 'True', 'False', 'IO', 'String'),
    lineComment: '--',
    quotes: ['"'],
  },
  html: {
    keywords: set(),
    lineComment: '',
    quotes: ['"', "'"],
    html: true,
  },
};

/** 语言 → 编辑器里显示的文件名（chrome 右上角那颗标签）。 */
const FILE_NAMES: Record<CodeLanguage, string> = {
  python: 'hello.py',
  javascript: 'hello.js',
  typescript: 'hello.ts',
  java: 'Hello.java',
  c: 'hello.c',
  cpp: 'hello.cpp',
  csharp: 'Hello.cs',
  go: 'hello.go',
  rust: 'hello.rs',
  ruby: 'hello.rb',
  php: 'hello.php',
  swift: 'hello.swift',
  kotlin: 'hello.kt',
  r: 'hello.R',
  bash: 'hello.sh',
  lua: 'hello.lua',
  haskell: 'hello.hs',
  html: 'hello.html',
};

// -- 分词 ---------------------------------------------------------------------

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;

/** HTML：标签扫描（`<>` 里的标签名 / 属性 / 属性值，标签外是正文）。 */
const tokenizeHtmlLine = (line: string): CodeToken[] => {
  const out: CodeToken[] = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    if (line.startsWith('<!--', i)) {
      const end = line.indexOf('-->', i + 4);
      const stop = end >= 0 ? end + 3 : n;
      out.push({ text: line.slice(i, stop), kind: 'com' });
      i = stop;
      continue;
    }
    if (line[i] === '<') {
      let j = i + 1;
      if (line[j] === '/') j += 1;
      out.push({ text: line.slice(i, j), kind: 'pun' });
      let k = j;
      while (k < n && /[A-Za-z0-9-]/.test(line[k])) k += 1;
      if (k > j) out.push({ text: line.slice(j, k), kind: 'kw' });
      i = k;
      while (i < n && line[i] !== '>') {
        const c = line[i];
        if (c === '"' || c === "'") {
          let m = i + 1;
          while (m < n && line[m] !== c) m += 1;
          if (m < n) m += 1;
          out.push({ text: line.slice(i, m), kind: 'str' });
          i = m;
          continue;
        }
        if (/\s/.test(c)) {
          let m = i + 1;
          while (m < n && /\s/.test(line[m])) m += 1;
          out.push({ text: line.slice(i, m), kind: 'plain' });
          i = m;
          continue;
        }
        if (/[A-Za-z0-9_-]/.test(c)) {
          let m = i + 1;
          while (m < n && /[A-Za-z0-9_-]/.test(line[m])) m += 1;
          out.push({ text: line.slice(i, m), kind: 'typ' });
          i = m;
          continue;
        }
        out.push({ text: c, kind: 'pun' });
        i += 1;
      }
      if (i < n && line[i] === '>') {
        out.push({ text: '>', kind: 'pun' });
        i += 1;
      }
      continue;
    }
    let j = i + 1;
    while (j < n && line[j] !== '<') j += 1;
    out.push({ text: line.slice(i, j), kind: 'plain' });
    i = j;
  }
  return out;
};

/** 单行 → token[]。纯函数，一遍扫描，无回溯。 */
const tokenizeLine = (line: string, spec: LanguageSpec): CodeToken[] => {
  if (spec.html) return tokenizeHtmlLine(line);
  const out: CodeToken[] = [];
  const n = line.length;
  const push = (text: string, kind: CodeTokenKind): void => {
    if (text) out.push({ text, kind });
  };

  let i = 0;
  while (i < n) {
    const ch = line[i];

    if (spec.lineComment && line.startsWith(spec.lineComment, i)) {
      push(line.slice(i), 'com');
      break;
    }

    if (spec.blockComment && line.startsWith(spec.blockComment[0], i)) {
      const close = spec.blockComment[1];
      const end = line.indexOf(close, i + spec.blockComment[0].length);
      if (end >= 0) {
        push(line.slice(i, end + close.length), 'com');
        i = end + close.length;
        continue;
      }
      push(line.slice(i), 'com');
      break;
    }

    if (spec.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      push(line.slice(i, j), 'str');
      i = j;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._]/.test(line[j])) j += 1;
      push(line.slice(i, j), 'num');
      i = j;
      continue;
    }

    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < n && ID_PART.test(line[j])) j += 1;
      const word = line.slice(i, j);
      let kind: CodeTokenKind = 'plain';
      if (spec.keywords.has(word)) kind = 'kw';
      else if (word[0] >= 'A' && word[0] <= 'Z') kind = 'typ';
      else if (line[j] === '(') kind = 'fn';
      push(word, kind);
      i = j;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      let j = i + 1;
      while (j < n && (line[j] === ' ' || line[j] === '\t')) j += 1;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }

    // 其余的连续符号并成一段 punct。
    let j = i + 1;
    while (
      j < n &&
      !ID_PART.test(line[j]) &&
      !/\s/.test(line[j]) &&
      !spec.quotes.includes(line[j]) &&
      !(spec.lineComment && line.startsWith(spec.lineComment, j))
    ) {
      j += 1;
    }
    push(line.slice(i, j), 'pun');
    i = j;
  }
  return out;
};

// -- 工厂 ---------------------------------------------------------------------

export function createCodeTyping(options: CodeTypingOptions): SkillSceneHandle {
  const root = document.createElement('div');
  root.className = 'code-typing';
  root.setAttribute('aria-hidden', 'true');

  // chrome：三个交通灯 + 语言徽标 + 文件名。
  const chrome = document.createElement('div');
  chrome.className = 'code-typing__chrome';

  const dots = document.createElement('div');
  dots.className = 'code-typing__dots';
  for (let i = 0; i < 3; i += 1) {
    const dot = document.createElement('span');
    dot.className = 'code-typing__dot';
    dots.append(dot);
  }

  const badge = document.createElement('span');
  badge.className = 'code-typing__badge';

  const file = document.createElement('span');
  file.className = 'code-typing__file';

  chrome.append(dots, badge, file);

  const code = document.createElement('div');
  code.className = 'code-typing__code';

  const caret = document.createElement('span');
  caret.className = 'code-typing__caret';

  root.append(chrome, code);
  options.host.append(root);

  let snippets: readonly CodeSnippet[] = options.snippets ?? [];
  let cells: CodeChar[] = [];
  let lineEls: HTMLElement[] = [];
  let lineTextEls: HTMLElement[] = [];

  let visible = 0;
  let lineIndex = 0;
  let langIndex = 0;
  let state: 'type' | 'hold' | 'delete' | 'gap' = 'type';
  let stateAt = 0;
  let acc = 0;
  let last = 0;
  let frame = 0;
  let running = false;
  let disposed = false;

  const placeCaret = (line: number): void => {
    const el = lineTextEls[line];
    if (!el) return;
    if (caret.parentNode !== el) el.append(caret);
  };

  const setLineLive = (index: number, live: boolean): void => {
    const el = lineEls[index];
    if (!el) return;
    el.classList.toggle('is-pending', !live);
    el.classList.toggle('is-live', live);
  };

  /** 清空代码区与逐字符队列。 */
  const resetCode = (): void => {
    code.replaceChildren();
    lineEls = [];
    lineTextEls = [];
    cells = [];
    visible = 0;
    lineIndex = 0;
  };

  /** 按行数预建行元素（含行号），全部先挂在 `.is-pending`。 */
  const buildLines = (count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const line = document.createElement('div');
      line.className = 'code-typing__line is-pending';

      const lineno = document.createElement('span');
      lineno.className = 'code-typing__lineno';
      lineno.textContent = String(i + 1);

      const text = document.createElement('span');
      text.className = 'code-typing__text';

      line.append(lineno, text);
      code.append(line);
      lineEls.push(line);
      lineTextEls.push(text);
    }
  };

  /** 载入第 index 段：分词 → 展开成 cells → 建行 → 复位到起点。 */
  const loadSnippet = (index: number): void => {
    resetCode();
    const snippet = snippets[index];
    if (!snippet) return;

    badge.textContent = snippet.label;
    file.textContent = FILE_NAMES[snippet.lang] ?? 'hello';

    const spec = LANG_SPECS[snippet.lang];
    const tokenLines = snippet.lines.map((line) => tokenizeLine(line, spec));
    tokenLines.forEach((tokens, li) => {
      for (const token of tokens) {
        for (const ch of token.text) cells.push({ ch, kind: token.kind });
      }
      if (li < tokenLines.length - 1) cells.push({ ch: '\n', kind: 'plain' });
    });

    buildLines(tokenLines.length);
    placeCaret(0);
  };

  /** 追加一个字符（或推进一行）。只动一个节点，不读布局。 */
  const appendChar = (cell: CodeChar): void => {
    if (cell.ch === '\n') {
      lineIndex += 1;
      placeCaret(lineIndex);
      return;
    }
    setLineLive(lineIndex, true);
    placeCaret(lineIndex);
    const text = lineTextEls[lineIndex];
    const prev = caret.previousElementSibling as HTMLElement | null;
    const cls = `code-typing__tok--${cell.kind}`;
    if (prev && prev.classList.contains(cls) && prev.firstChild) {
      (prev.firstChild as Text).data += cell.ch;
      return;
    }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = cell.ch;
    text.insertBefore(span, caret);
  };

  /** 退掉末尾一个字符（或回退一行）。 */
  const deleteChar = (): void => {
    if (visible <= 0) return;
    const cell = cells[visible - 1];
    visible -= 1;

    if (cell.ch === '\n') {
      setLineLive(lineIndex, false);
      lineIndex -= 1;
      placeCaret(lineIndex);
      return;
    }
    const prev = caret.previousElementSibling as HTMLElement | null;
    if (!prev) return;
    const node = prev.firstChild as Text | null;
    if (node) node.data = node.data.slice(0, -1);
    if (!node || node.data === '') {
      prev.remove();
      if (!caret.previousElementSibling) setLineLive(lineIndex, false);
    }
  };

  const step = (now: number): void => {
    if (!running || disposed) return;
    const dt = last ? now - last : 0;
    last = now;
    acc += dt;

    if (state === 'type') {
      while (acc >= TYPE_MS && visible < cells.length) {
        acc -= TYPE_MS;
        appendChar(cells[visible]);
        visible += 1;
      }
      if (visible >= cells.length) {
        state = 'hold';
        stateAt = now;
        acc = 0;
      }
    } else if (state === 'hold') {
      if (now - stateAt >= HOLD_MS) {
        state = 'delete';
        acc = 0;
      }
    } else if (state === 'delete') {
      while (acc >= DELETE_MS && visible > 0) {
        acc -= DELETE_MS;
        deleteChar();
      }
      if (visible <= 0) {
        state = 'gap';
        stateAt = now;
        acc = 0;
      }
    } else if (now - stateAt >= GAP_MS) {
      langIndex = (langIndex + 1) % snippets.length;
      loadSnippet(langIndex);
      state = 'type';
      acc = 0;
    }

    frame = window.requestAnimationFrame(step);
  };

  const stop = (): void => {
    running = false;
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };

  const start = (): void => {
    if (disposed || running) return;
    running = true;
    state = 'type';
    stateAt = 0;
    acc = 0;
    last = 0;
    frame = window.requestAnimationFrame(step);
  };

  /** 静态呈现：整段一次画满、光标不闪、不跑循环（reduced-motion 用）。 */
  const renderStatic = (index: number): void => {
    stop();
    loadSnippet(index);
    while (visible < cells.length) {
      appendChar(cells[visible]);
      visible += 1;
    }
    caret.remove();
  };

  const play = (content: SkillCardContent): void => {
    snippets = content.code?.snippets ?? [];
    if (!snippets.length) {
      stop();
      resetCode();
      return;
    }
    langIndex = 0;
    loadSnippet(0);
    if (prefersReducedMotion()) {
      renderStatic(0);
      return;
    }
    start();
  };

  return {
    element: root,
    show: () => {
      root.style.opacity = '1';
      root.classList.add('is-visible');
    },
    hide: () => {
      root.style.opacity = '0';
      root.classList.remove('is-visible');
    },
    play,
    cancel: stop,
    dispose: () => {
      disposed = true;
      stop();
      root.remove();
    },
  };
}

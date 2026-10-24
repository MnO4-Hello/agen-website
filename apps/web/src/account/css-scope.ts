/**
 * 自定义 CSS 的作用域化。
 *
 * 用户在设置页写的样式**只该影响他自己的主页**。做法是解析成 CSSOM 之后，给每条
 * 选择器加上 `.uprofile ` 前缀，再拼回一段新的样式表。
 *
 * 为什么用 CSSOM 而不是正则加前缀：正则会死在注释、字符串、嵌套 `@media`、以及
 * 逗号分组选择器上（`a, .b` 加前缀必须加在每一段上，正则很容易只处理第一段）。
 * CSSOM 虽然是「解析后再序列化」，会丢掉注释与格式——但这是编译产物，无所谓。
 *
 * 服务端还有一层黑名单（`users/profile-validate.ts`），那不是替代品：
 * 老数据里可能已经存了脏东西，两层都要有。
 */

/** 这几个选择器加前缀后会变成 `.uprofile body`（永远不匹配），所以直接丢弃并提示。 */
const UNSCOPABLE = /^(html|body|:root|:host)\b/i;

/** 与服务端同一份规则。前端也拦一次是纵深防御，不是重复劳动。 */
const FORBIDDEN =
  /@(import|charset|namespace|font-face|page|property|layer|counter-style|scope)\b|url\s*\(|expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|<\s*\/?\s*(script|style|iframe)/i;

export const CSS_MAX_BYTES = 8192;

export function cssByteLength(css: string): number {
  return new TextEncoder().encode(css).length;
}

export interface CssCheck {
  ok: boolean;
  /** 给用户看的一句话；`ok` 时为空串。 */
  message: string;
}

/**
 * 保存前的本地预检。
 *
 * 只覆盖「一眼能看出来」的三类错误：超体积、用了被禁的写法、大括号没闭合。
 * 其余语法问题浏览器会静默丢弃——这是 CSS 的既定行为，UI 上用一句常驻灰字说明。
 */
export function checkCssInput(css: string): CssCheck {
  if (cssByteLength(css) > CSS_MAX_BYTES) {
    return { ok: false, message: `超过 ${CSS_MAX_BYTES / 1024}KB 了（中文一个字算 3 字节）。` };
  }
  const scan = css.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
  const hit = FORBIDDEN.exec(scan);
  if (hit) return { ok: false, message: `不允许使用 ${hit[0]}。` };

  let depth = 0;
  let line = 1;
  let openLine = 1;
  for (const ch of scan) {
    if (ch === '\n') line += 1;
    else if (ch === '{') {
      if (depth === 0) openLine = line;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return { ok: false, message: `第 ${line} 行多了一个 }。` };
    }
  }
  if (depth !== 0) return { ok: false, message: `第 ${openLine} 行的 { 没有闭合。` };

  return { ok: true, message: '' };
}

/* ---------------------------------------------------------------------------
   解析
--------------------------------------------------------------------------- */

function parseRules(css: string): CSSRuleList | null {
  // 优先用构造式样式表：不碰 DOM、不会引一次样式重算。
  const Sheet = window.CSSStyleSheet;
  if (Sheet && 'replaceSync' in Sheet.prototype) {
    try {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      return sheet.cssRules;
    } catch {
      // 极少数语法（例如在 worker 之外被禁用的 @import）会抛，落到下面那条路。
    }
  }
  // 兜底：临时挂一个 <style> 再读它的 sheet。老 Safari 走这条。
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  const rules = style.sheet?.cssRules ?? null;
  style.remove();
  return rules;
}

/** 逗号分组要逐段加前缀；`html/body/:root` 那几段直接丢掉（加前缀后永远不匹配）。 */
function scopeSelector(selector: string, scope: string): string {
  return selector
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !UNSCOPABLE.test(part))
    .map((part) => `${scope} ${part}`)
    .join(', ');
}

/** `animation` / `animation-name` 里的名字要跟着改名，否则重命名后的 keyframes 不会被引用。 */
function renameAnimations(style: CSSStyleDeclaration, map: Map<string, string>): void {
  for (const prop of ['animation', 'animation-name']) {
    const value = style.getPropertyValue(prop);
    if (!value) continue;
    const next = value
      .split(/(\s+|,)/)
      .map((token) => map.get(token.trim()) ?? token)
      .join('');
    if (next !== value) style.setProperty(prop, next);
  }
}

function escapeName(name: string): string {
  return /^[A-Za-z_][\w-]*$/.test(name) ? name : name.replace(/[^\w-]/g, '_');
}

/*
 * 规则判定。
 *
 * ⚠️ **不要**直接写 `rule instanceof CSSKeyframesRule`：jsdom 和一部分老 WebView
 * 根本没有这些构造器，`instanceof` 会抛 `ReferenceError` 而不是返回 false
 * （account-test.mjs 在 jsdom 里就是这么炸的）。所以先看构造器在不在，
 * 不在就退回 `CSSRule.type` 这个更老、更普遍存在的数字常量。
 */
const RULE_TYPE = { style: 1, media: 4, keyframes: 7, supports: 12 } as const;

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return typeof CSSStyleRule !== 'undefined'
    ? rule instanceof CSSStyleRule
    : rule.type === RULE_TYPE.style;
}

function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return typeof CSSMediaRule !== 'undefined'
    ? rule instanceof CSSMediaRule
    : rule.type === RULE_TYPE.media;
}

function isSupportsRule(rule: CSSRule): rule is CSSSupportsRule {
  return typeof CSSSupportsRule !== 'undefined'
    ? rule instanceof CSSSupportsRule
    : rule.type === RULE_TYPE.supports;
}

function isKeyframesRule(rule: CSSRule): rule is CSSKeyframesRule {
  return typeof CSSKeyframesRule !== 'undefined'
    ? rule instanceof CSSKeyframesRule
    : rule.type === RULE_TYPE.keyframes;
}

/** `@keyframes` 内部的每一步。jsdom 没有 `CSSKeyframeRule`，用 `keyText` 兜底。 */
function isKeyframeStep(step: CSSRule): step is CSSKeyframeRule {
  return typeof CSSKeyframeRule !== 'undefined'
    ? step instanceof CSSKeyframeRule
    : 'keyText' in step;
}

export interface ScopedCss {
  /** 拼好的、可以直接塞进 `<style>` 的文本。 */
  text: string;
  /** 被丢掉的东西（给用户看的提示，已去重）。 */
  dropped: string[];
}

/**
 * 把一段用户 CSS 变成「只作用于 `scope` 子树」的样式表。
 *
 * `prefix` 用于给 `@keyframes` 改名——名字是全局共享的，不同用户的 `spin` 会互相覆盖。
 */
export function scopeCss(css: string, scope: string, prefix: string): ScopedCss {
  const rules = parseRules(css);
  if (!rules) {
    return { text: '', dropped: ['这段 CSS 没解析出来，可能语法有问题。'] };
  }

  const dropped = new Set<string>();

  // 第一遍：先把 @keyframes 的名字收齐，第二遍才知道要改哪些 animation 引用。
  const frames = new Map<string, string>();
  const collect = (list: CSSRuleList): void => {
    for (const rule of list) {
      if (isKeyframesRule(rule)) {
        frames.set(rule.name, `${prefix}-${escapeName(rule.name)}`);
      } else if ('cssRules' in rule) {
        collect((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  collect(rules);

  const walk = (list: CSSRuleList): string => {
    let out = '';
    for (const rule of list) {
      if (isStyleRule(rule)) {
        const selector = rule.selectorText;
        if (UNSCOPABLE.test(selector.split(',')[0]?.trim() ?? '')) {
          dropped.add('html / body / :root 选择器不生效，底色请用上面的主题配色');
        }
        const scoped = scopeSelector(selector, scope);
        if (!scoped) continue;
        renameAnimations(rule.style, frames);
        out += `${scoped}{${rule.style.cssText}}`;
        continue;
      }

      if (isMediaRule(rule) || isSupportsRule(rule)) {
        const condition = isMediaRule(rule)
          ? `@media ${rule.conditionText}`
          : `@supports ${rule.conditionText}`;
        const inner = walk(rule.cssRules);
        if (inner) out += `${condition}{${inner}}`;
        continue;
      }

      if (isKeyframesRule(rule)) {
        const renamed = frames.get(rule.name) ?? `${prefix}-${escapeName(rule.name)}`;
        const steps = [...rule.cssRules]
          .map((step) => (isKeyframeStep(step) ? `${step.keyText}{${step.style.cssText}}` : ''))
          .join('');
        out += `@keyframes ${renamed}{${steps}}`;
        continue;
      }

      // @font-face / @page / @import …：服务端已经拦过，这里是第二道。
      dropped.add(`${rule.cssText.slice(0, 40)}… 这类规则不支持，已忽略`);
    }
    return out;
  };

  return { text: walk(rules), dropped: [...dropped] };
}

export interface AppliedCss {
  dispose(): void;
}

/**
 * 把作用域化后的样式挂到 root 里。
 *
 * 用 `<style>` 而不是 `adoptedStyleSheets`：它跟着 DOM 一起消失，`dispose()` 不会
 * 忘记摘（忘记了就会在关掉页面之后继续影响下一次预览）；调试时也能直接看到成品文本。
 *
 * 作用域固定是 `.uprofile`——主页皮肤的根节点，全站只有这一个地方渲染用户 CSS。
 */
export function applyScopedCss(root: HTMLElement, css: string): { applied: AppliedCss; dropped: string[] } {
  const style = document.createElement('style');
  style.dataset.scoped = 'uprofile';
  const trimmed = css.trim();
  if (!trimmed) return { applied: { dispose: () => style.remove() }, dropped: [] };

  const scoped = scopeCss(trimmed, '.uprofile', 'up');
  style.textContent = scoped.text;
  root.prepend(style);
  return { applied: { dispose: () => style.remove() }, dropped: scoped.dropped };
}

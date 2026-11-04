/**
 * 站内媒体图的**唯一** URL 改写点。
 *
 * 后端的存储约定（见 `apps/api/src/media/derivatives.ts`）是：
 *
 *   /api/works/media/w-0a3a94442b2ed304.png       原图（入库、永久保留）
 *   /api/works/media/w-0a3a94442b2ed304-t.webp    长边 ≤ 512，给头像 / 列表卡 / 图集格子
 *   /api/works/media/w-0a3a94442b2ed304-c.webp    长边 ≤ 1920，给正文插图 / 详情横幅
 *
 * 数据库里**只存原图 URL**，压缩图的 URL 在这里用字符串改写派生出来。这么做的理由：
 *
 *   1. 入库校验的 4 条正则（`blog/validate.ts`、`works/validate.ts`、
 *      `message/validate.ts`、`profile-types.ts`）一行都不用改，历史数据零风险；
 *   2. 派生图的字节由「原图内容哈希 + 固定后缀」确定，所以后端可以继续用
 *      `immutable` 一年长缓存；
 *   3. 万一以后不想用派生图，把 `displayUrl()` 改成 `return src` 就整体回滚了。
 *
 * ⚠️ 只改写**同源**的 `/api/{blog,messages,works,account}/media/<name>`。
 * 博客正文与作品 README 里可能贴着第三方图床的图，那些必须原样放过。
 */

export type MediaTier = 'thumb' | 'content';

/** 前缀字母 → 直链目录。前缀已经唯一确定了所属图床。 */
const PREFIX_DIR: Record<string, string> = {
  b: '/api/blog/media/',
  m: '/api/messages/media/',
  w: '/api/works/media/',
  a: '/api/account/media/',
};

/** 原图名（入库形状）。派生图不在这个集合里。 */
const NAME_RE = /^([bmwa])-([a-f0-9]{16})\.(png|jpg|webp|gif|avif)$/;

/** 从一条 src 的 pathname 里拆出「目录 + 基名 + 扩展名」。 */
const SRC_RE = /^(\/api\/(?:blog|messages|works|account)\/media\/)([bmwa]-[a-f0-9]{16})\.(png|jpg|webp|gif|avif)$/;

interface MediaRef {
  readonly dir: string;
  readonly name: string;
}

function refOf(src: string): MediaRef | null {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const match = SRC_RE.exec(url.pathname);
  if (!match) return null;
  return { dir: match[1] ?? '', name: `${match[2] ?? ''}.${match[3] ?? ''}` };
}

/**
 * 展示用 URL。不是站内媒体图就原样返回（外站图片、`public/` 下的静态图都走这条）。
 */
export function displayUrl(src: string, tier: MediaTier): string {
  const ref = refOf(src);
  if (!ref) return src;
  const base = ref.name.slice(0, ref.name.lastIndexOf('.'));
  return `${ref.dir}${base}-${tier === 'thumb' ? 't' : 'c'}.webp`;
}

/** 原图文件名（`w-0a3a94442b2ed304.png`）。不是站内媒体图时返回 null。 */
export function mediaNameOf(src: string): string | null {
  return refOf(src)?.name ?? null;
}

/** 原图页的站内链接。不是站内媒体图时返回 null（调用方应退回普通节点）。 */
export function photoHref(src: string): string | null {
  const name = mediaNameOf(src);
  return name ? `#photo/${encodeURIComponent(name)}` : null;
}

/** 原图页用：文件名 → 直链。名字形状不对返回 null。 */
export function mediaUrlOfName(name: string): string | null {
  const match = NAME_RE.exec(name);
  if (!match) return null;
  return `${PREFIX_DIR[match[1] ?? ''] ?? ''}${name}`;
}

/* ---------------------------------------------------------------------------
   原图页的「从哪来」
--------------------------------------------------------------------------- */

const PHOTO_ORIGIN_KEY = 'agen:photo:origin';

/**
 * 记住当前页的 hash，供原图页的「返回」使用。
 *
 * 为什么不用 `history.back()`：直接把 `#photo/...` 的链接粘进新标签页打开时，
 * back 会把用户送出本站。存一份来源 hash 则两种情况都对。
 */
function rememberPhotoOrigin(): void {
  try {
    const hash = window.location.hash;
    if (!hash || hash.startsWith('#photo')) return;
    window.sessionStorage.setItem(PHOTO_ORIGIN_KEY, hash);
  } catch {
    // 隐私模式禁用 sessionStorage：退化成「没有来源」，原图页回首页。
  }
}

/**
 * 原图页的返回目标。**不删**这条记录：刷新之后返回键仍然指向同一个来源。
 *
 * 来源已被删除（比如原来那条留言没了）时也无所谓——那是普通的路由跳转，
 * 具体页面自己会处理「找不到」。
 */
export function consumePhotoOrigin(): string {
  try {
    const saved = window.sessionStorage.getItem(PHOTO_ORIGIN_KEY);
    if (saved && saved.startsWith('#') && !saved.startsWith('#photo')) return saved;
  } catch {
    /* 同上 */
  }
  return '#home';
}

/* ---------------------------------------------------------------------------
   节点工厂
--------------------------------------------------------------------------- */

export interface MediaImageOptions {
  readonly src: string;
  readonly tier: MediaTier;
  readonly alt?: string;
  readonly className?: string;
  readonly loading?: 'lazy' | 'eager';
  readonly referrerPolicy?: ReferrerPolicy;
  /** 派生图与原图**都**失败时回调（头像用它退回首字色块）。 */
  readonly onFallbackFailed?: () => void;
}

/**
 * 统一构造 `<img>`：压缩图优先、`lazy` + `decoding=async`、失败回退原图。
 *
 * 回退只做一次（`dataset.fallback` 标记）。派生图缺失只可能发生在「历史图还没跑
 * 补齐脚本」那一小段时间里，多一次 404 之后就会稳定在原图上，不会循环重试。
 */
export function createMediaImage(options: MediaImageOptions): HTMLImageElement {
  const original = options.src;
  const img = document.createElement('img');

  if (options.className) img.className = options.className;
  img.alt = options.alt ?? '';
  img.loading = options.loading ?? 'lazy';
  img.decoding = 'async';
  if (options.referrerPolicy) img.referrerPolicy = options.referrerPolicy;

  img.src = displayUrl(original, options.tier);

  img.addEventListener('error', () => {
    if (img.dataset.fallback === '1') {
      options.onFallbackFailed?.();
      return;
    }
    img.dataset.fallback = '1';
    img.src = original;
  });

  return img;
}

/**
 * 包一层跳原图页的站内链接。
 *
 * 不是站内媒体图时退回一个同 class 的 `<span>`——版式不变，只是不能点。
 */
export function photoLink(src: string, content: HTMLElement, className?: string): HTMLElement {
  const href = photoHref(src);
  if (!href) {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.append(content);
    return span;
  }

  const anchor = document.createElement('a');
  if (className) anchor.className = className;
  anchor.href = href;
  anchor.addEventListener('click', rememberPhotoOrigin);
  anchor.append(content);
  return anchor;
}

/**
 * 后处理一段已经渲染好的正文：把站内图片换成压缩图 + 原图链接，外站图片原样放过。
 *
 * 为什么不在 `shared/markdown.ts` 里直接生成链接：那个渲染器同时被**后台实时预览**
 * 引用（`admin/preview.ts`），在渲染器里产出 `#photo/...` 会把后台自己的哈希路由带跑偏。
 * 放在调用方后处理，前后台互不影响。
 */
export function enhanceMediaImages(root: ParentNode, tier: MediaTier): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!mediaNameOf(src)) continue;

    /*
     * 不照抄原 `<img>` 的 `referrerPolicy`：这里只处理**本站**媒体直链，
     * 同源请求带不带 Referer 都无所谓；而 `no-referrer` 那条例外原本是给
     * Markdown 里引用外站图床的唯一用处，外站图片根本走不到这个分支。
     */
    const next = createMediaImage({ src, tier, alt: img.alt });
    img.replaceWith(photoLink(src, next));
  }
}

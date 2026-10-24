/**
 * 作品的领域类型。
 *
 * 这里是「唯一真相」，前端 `apps/web/src/works/api.ts` 与 `apps/web/src/admin/api.ts`
 * 各自镜像了公开 / 管理两份视图。改字段名时三处一起改——没有生成器，也不想为此
 * 引入一个跨 workspace 的共享包（Vite 与 tsc 两套构建的路径解析会立刻变复杂）。
 */

export type WorkMode = 'template' | 'developer';

/** 落盘的一条记录：含正文与 slug，只有管理后台看得到全部字段。 */
export interface WorkRecord {
  /** 内部 id（`randomUUID`），不出现在任何 URL 里，用来做「改名不影响链接」。 */
  id: string;
  /** URL 段，唯一，`^[a-z0-9]+(?:-[a-z0-9]+)*$`。 */
  slug: string;
  mode: WorkMode;
  title: string;
  summary: string;
  tags: string[];
  year: string;
  category: string;
  repoUrl: string;
  demoUrl: string;
  /** `/api/works/media/w-xxxxxxxxxxxxxxxx.png`，空串表示没有封面。 */
  thumbnail: string;
  gallery: string[];
  /** 模板模式的 Markdown。开发者模式下恒为空串。 */
  readme: string;
  /** 开发者模式的整页 HTML。模板模式下恒为空串。 */
  html: string;
  published: boolean;
  /** 列表排序，小的在前。 */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** 公开列表项：不带正文、不带内部 id、不带发布状态。 */
export interface WorkSummary {
  slug: string;
  mode: WorkMode;
  title: string;
  summary: string;
  tags: string[];
  year: string;
  category: string;
  thumbnail: string;
  order: number;
  updatedAt: string;
}

/** 公开详情：摘要 + 正文与外链。 */
export interface WorkDetail extends WorkSummary {
  repoUrl: string;
  demoUrl: string;
  gallery: string[];
  readme: string;
  html: string;
}

/** `works.json` 的顶层结构。`version` 留给以后的迁移用，现在只会是 1。 */
export interface WorksState {
  version: 1;
  updatedAt: string;
  items: WorkRecord[];
}

/**
 * 校验后的可写字段（不含 id / slug / 时间戳）。
 *
 * 抽取它是为了让 create 与 update 共用同一套校验：update 用「旧记录」当 base，
 * 缺字段就沿用旧值——管理后台的发布开关、排序按钮只传一个字段，不该被要求带全量。
 */
export type WorkFields = Omit<WorkRecord, 'id' | 'slug' | 'createdAt' | 'updatedAt'>;

export function pickSummary(record: WorkRecord): WorkSummary {
  return {
    slug: record.slug,
    mode: record.mode,
    title: record.title,
    summary: record.summary,
    tags: [...record.tags],
    year: record.year,
    category: record.category,
    thumbnail: record.thumbnail,
    order: record.order,
    updatedAt: record.updatedAt,
  };
}

export function pickDetail(record: WorkRecord): WorkDetail {
  return {
    ...pickSummary(record),
    repoUrl: record.repoUrl,
    demoUrl: record.demoUrl,
    gallery: [...record.gallery],
    readme: record.readme,
    html: record.html,
  };
}

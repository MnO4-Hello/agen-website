/**
 * 站点模式的**运行期真源**：内存 holder + 落盘覆盖文件。
 *
 * 之前 `SITE_MODE` 是环境变量，改一次要 `pm2 restart`。现在后台能直接拨，
 * 所以需要有地方记住「最后一个人选了什么」，并且重启之后还在。
 *
 * ## 三条规则
 *
 * 1. **优先级**：`apps/api/data/site-mode.json` 存在就以它为准；不存在才用环境变量。
 *    这样 `.env` 只决定「后台还没人动过时的初始形态」，之后手改 `.env` 不会覆盖后台的选择
 *    （否则会出现「我在后台切了、重启又回去了」这种最让人困惑的状态）。
 * 2. **文件坏了回退到 `display`**，绝不回退 `full`。读不懂当前状态时把社区放出去，
 *    是这个开关最不该犯的错；同时也不自动重写文件——悄悄重置等于把用户的意图抹掉，
 *    后台会把 `corrupt: true` 显示出来，站长下一次切换就顺手修好了。
 * 3. **先落盘、后换内存**。磁盘是持久真源，写失败时内存必须保持原样，
 *    否则会出现「页面说切换成功、重启后全变回去」。
 *
 * ## 为什么不复用 `data/json-store.ts`
 *
 * 它有两处语义与本文件冲突：`read()` 在文件不存在时会 `createEmpty()` **并落盘**
 * （等于第一次启动就把 `.env` 抄进文件，以后改 `.env` 永久无效）；`mutate()` 在文件损坏时
 * 直接抛错（把「靠一次切换修复损坏文件」这条路堵死）。这里的读写都只有几十行，
 * 另写一份比给共享件加两个开关更安全——那套已经在跑生产数据了。
 *
 * ⚠️ holder 是**进程内**的。`ecosystem.config.cjs` 写死 `instances: 1`，所以成立；
 * 真要横向扩容，得先换成「每次读文件 mtime」或加广播，否则表现为「切了没生效，刷新又生效」。
 */

import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSiteMode,
  parseSiteMode,
  resolveSiteConfig,
  SITE_FEATURES,
  type SiteConfig,
  type SiteFeature,
  type SiteMode,
} from './mode.js';

/**
 * `apps/api` 的绝对路径。源码在 `src/site/runtime.ts`、编译在 `dist/site/runtime.js`，
 * 两者都往上两跳：`site/` → `src|dist` → `api`。与 `users/store.ts` 同一个写法。
 */
const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_DIR = path.join(API_ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'site-mode.json');

/** 给日志与后台提示用的相对路径，别把服务器的绝对路径暴露到前端。 */
export const SITE_MODE_FILE_LABEL = 'apps/api/data/site-mode.json';

/** 当前这份配置是从哪儿来的。后台要显示出来，否则「点了没反应」会被当成 bug。 */
export type SiteModeSource = 'env' | 'file' | 'fallback';

export interface SiteModeSnapshot {
  readonly mode: SiteMode;
  readonly features: Readonly<Record<SiteFeature, boolean>>;
  readonly source: SiteModeSource;
  /** 环境变量里写的是什么（后台要用它解释「为什么我切不动」）。 */
  readonly envMode: SiteMode;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** 存储文件存在但读不懂；下一次切换会覆盖它（旧文件留 `.bak`）。 */
  readonly corrupt: boolean;
}

/** 落盘形状。与其它数据文件一致：`version` + 业务字段 + 时间戳。 */
interface StoredState {
  version: 1;
  mode: SiteMode;
  updatedAt: string;
  updatedBy: string;
}

/**
 * 环境变量里写的模式。**用函数读，不要在模块顶层算成常量。**
 *
 * ESM 的静态 `import` 先于模块体的任何语句执行，而 `server.ts` 里的
 * `process.loadEnvFile()` 是「语句」——也就是说本模块求值时 `.env` 还没被加载，
 * 顶层拿到的是 `undefined`，`parseSiteMode('')` 会给出 `full`。
 * 线上就因此出现过「`.env` 明明写着 display、接口却是 full」：shell 里传的
 * `SITE_MODE=display npm run dev` 能正常工作，只有读 `.env` 的部署会错位。
 */
function envModeValue(): SiteMode {
  return parseSiteMode(process.env.SITE_MODE);
}

/**
 * 初始值只有 fail-closed 的 `display`，真正的判定在 `initSiteMode()` 里。
 * 保留一个「最严格」的初值，是为了万一有人在 `initSiteMode()` 之前读了
 * `currentSiteConfig()`，拿到的也是关着的状态，而不是全开。
 */
let config: SiteConfig = resolveSiteConfig('display');
let source: SiteModeSource = 'env';
let stored: StoredState | null = null;
let corrupt = false;

let chain: Promise<unknown> = Promise.resolve();
let sequence = 0;

/** Windows 上 `rename` 偶尔会 EPERM（杀毒软件短暂占用目标文件），重试两次就过去了。 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retriable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (attempt >= 2 || !retriable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/**
 * 排到队尾。`chain.then(task, task)` 是关键：前一个任务失败时也要继续跑下一个，
 * 否则一次写失败会让整条队列永久卡死。
 */
function exclusive<R>(task: () => Promise<R>): Promise<R> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 整份落盘。顺序：备份旧文件 → 写临时文件 → fsync → rename。 */
async function persist(state: StoredState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await copyFile(STATE_FILE, `${STATE_FILE}.bak`).catch(() => undefined);

  const body = `${JSON.stringify(state, null, 2)}\n`;
  sequence += 1;
  const tmp = path.join(DATA_DIR, `.site-mode.json.${process.pid}.${Date.now()}.${sequence}.tmp`);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, STATE_FILE);
}

/** 严格解析存储文件。任何一处不对都算损坏，不做「猜一个」的容错。 */
function parseStored(raw: string): StoredState {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('顶层不是对象');
  const record = parsed as Record<string, unknown>;
  if (!isSiteMode(record.mode)) {
    throw new Error(`mode 不是合法值：${JSON.stringify(record.mode)}`);
  }
  return {
    version: 1,
    mode: record.mode,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    updatedBy: typeof record.updatedBy === 'string' ? record.updatedBy : '',
  };
}

export interface InitResult {
  readonly snapshot: SiteModeSnapshot;
  /** 读文件失败时的原因，给启动日志用；正常为 `null`。 */
  readonly error: string | null;
}

/**
 * 启动时读一次存储文件。`buildApp()` 里 `await` 它，之后所有请求同步读 holder。
 *
 * 不抛异常：读失败也只是降级到 `display`，让进程照常起来——站点关着比进程起不来好，
 * 而且后台还能通过一次切换把坏文件覆盖掉。
 */
export async function initSiteMode(): Promise<InitResult> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // 正常态：后台还没切过，用环境变量。**不写文件**，否则 .env 从此失效。
      config = resolveSiteConfig(envModeValue());
      source = 'env';
      return { snapshot: siteModeSnapshot(), error: null };
    }
    corrupt = true;
    source = 'fallback';
    const reason = (error as Error).message;
    config = resolveSiteConfig('display');
    return { snapshot: siteModeSnapshot(), error: `${SITE_MODE_FILE_LABEL} 读不出来（${reason}），已回退 display` };
  }

  try {
    stored = parseStored(raw);
    source = 'file';
    config = resolveSiteConfig(stored.mode);
    return { snapshot: siteModeSnapshot(), error: null };
  } catch (error) {
    corrupt = true;
    source = 'fallback';
    config = resolveSiteConfig('display');
    return {
      snapshot: siteModeSnapshot(),
      error: `${SITE_MODE_FILE_LABEL} 不是合法配置（${(error as Error).message}），已回退 display；下一次后台切换会覆盖它`,
    };
  }
}

/** 当前生效的配置。**每个请求都要问它**，别缓存到闭包里。 */
export function currentSiteConfig(): SiteConfig {
  return config;
}

export function siteModeSnapshot(): SiteModeSnapshot {
  return {
    mode: config.mode,
    features: config.features,
    source,
    envMode: envModeValue(),
    updatedAt: stored?.updatedAt || null,
    updatedBy: stored?.updatedBy || null,
    corrupt,
  };
}

/**
 * 切换模式：先落盘，成功后换内存。
 *
 * 写失败时内存保持原样并抛出，调用方（`routes/admin-settings.ts`）回 500——
 * 「接口说成功了但重启后变回去」是这套功能里最难查、代价最高的一种不一致。
 */
export async function writeSiteMode(mode: SiteMode, actor: string): Promise<SiteModeSnapshot> {
  const state: StoredState = {
    version: 1,
    mode,
    updatedAt: new Date().toISOString(),
    updatedBy: actor,
  };

  await exclusive(async () => {
    await persist(state);
    // 落盘成功之后才动内存；这两行之间只有微秒级的窗口，崩了也是「磁盘新、内存旧」，
    // 重启读文件就一致了。
    stored = state;
    source = 'file';
    corrupt = false;
    config = resolveSiteConfig(mode);
  });

  return siteModeSnapshot();
}

/** 被关掉的功能名，给启动日志与后台提示用。 */
export function disabledFeatures(snapshot: SiteModeSnapshot): SiteFeature[] {
  return SITE_FEATURES.filter((name) => !snapshot.features[name]);
}

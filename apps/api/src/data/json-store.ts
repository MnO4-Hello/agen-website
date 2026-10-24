/**
 * 通用的「JSON 文件 + 串行队列 + 原子写」存储。
 *
 * `works/store.ts` 里已经有一份同样的实现，但它的 `exclusive` / `persist` / `readState`
 * 全是模块私有、且错误类型写死成 `WorkError`。这里刻意**再写一份而不是去改它**：
 * 作品那套已经跑在生产上（三条作品、图片上传、后台编辑都在用），为了复用几十行
 * 基础设施去动它，收益远小于风险。等哪天真的有三个以上的 store，再回头统一。
 *
 * 三条纪律照抄 `works/store.ts`，别删：
 *
 *   1. **原子写**：写临时文件 → `fsync` → `rename`。断电只会留下一个 `.tmp`，
 *      数据文件要么是旧的、要么是新的，不会是一半。
 *   2. **串行队列**：同一个 store 的所有「读-改-写」走同一条 Promise 链。
 *      并发注册两个同名账号时，第二个一定在第一个落盘之后才做唯一性检查。
 *   3. **解析失败不静默重置**：文件坏了就抛错让人去修。悄悄重置等于把用户全删了。
 *
 * 队列是**每个 store 实例一条**（不是全局限一条）：作品与账号互不相干，没必要排队。
 */

import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

export interface JsonStoreOptions<T> {
  /** 数据目录，不存在会自动创建。 */
  readonly dir: string;
  /** 数据文件的绝对路径（同目录会生成 `<文件名>.bak`）。 */
  readonly filePath: string;
  /** 文件不存在时写入的初始内容。 */
  readonly createEmpty: () => T;
  /** 结构校验：不合法就抛错（错误类型由 `fail` 决定），**不要**在这里做「修复」。 */
  readonly parse: (raw: unknown) => T;
  /** 把一句中文说明包成调用方域内的错误类型。 */
  readonly fail: (message: string) => Error;
}

export interface JsonStore<T> {
  readonly filePath: string;
  /** 读整份状态；文件不存在会先落一份空状态。 */
  read(): Promise<T>;
  /** 串行「读-改-写」：`fn` 抛错则不落盘，错误原样抛给调用方。 */
  mutate<R>(fn: (state: T) => R | Promise<R>): Promise<R>;
}

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

export function createJsonStore<T>(options: JsonStoreOptions<T>): JsonStore<T> {
  const { dir, filePath, createEmpty, parse, fail } = options;
  const base = path.basename(filePath);

  let chain: Promise<unknown> = Promise.resolve();
  let sequence = 0;

  /**
   * 排到队尾。
   *
   * `chain.then(task, task)` 是关键：前一个任务失败时也要继续跑下一个，否则一次校验
   * 失败会让整条队列永久卡死。`chain` 自身被吞成 `undefined`，不让 rejection 泄漏成
   * 「未处理的 Promise 拒绝」。
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
  async function persist(state: T): Promise<void> {
    await mkdir(dir, { recursive: true });
    // 上一版留档。第一次写入时文件还不存在，`copyFile` 会 ENOENT——忽略即可。
    await copyFile(filePath, `${filePath}.bak`).catch(() => undefined);

    const body = `${JSON.stringify(state, null, 2)}\n`;
    sequence += 1;
    const tmp = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${sequence}.tmp`);
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, filePath);
  }

  /** 队列内部用的读：不能自己再进队，否则 `mutate` 会把自己锁死。 */
  async function readInner(): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const state = createEmpty();
        await persist(state);
        return state;
      }
      throw fail(`读取 ${base} 失败：${(error as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 绝不重置：那会把所有账号清空，还显示一切正常。
      throw fail(`${base} 不是合法的 JSON，请先修好这个文件（同目录有 .bak）。`);
    }

    return parse(parsed);
  }

  return {
    filePath,
    read: () => exclusive(readInner),
    mutate: <R>(fn: (state: T) => R | Promise<R>): Promise<R> =>
      exclusive(async () => {
        const state = await readInner();
        const result = await fn(state);
        await persist(state);
        return result;
      }),
  };
}

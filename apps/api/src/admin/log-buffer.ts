/**
 * 后端进程输出的内存缓冲。
 *
 * 管理后台的「控制台」要能实时看到后台在干什么，而 Node 进程的输出有两类：
 *
 *   1. **Fastify 自己的 pino 日志**（每个请求一条 JSON）—— 走 `process.stdout.write`；
 *   2. **别人往终端写的东西**：`console.log`、tsx / Node 的警告、未捕获异常 —— 也走
 *      `process.stdout` / `process.stderr`。
 *
 * 两类都落在 stdout/stderr 上，所以这里**直接给两条流各套一层 write 钩子**：先把内容抄进
 * 环形缓冲，再原样交给原来的 write。好处是不用关心上面的库换了什么 logger；代价是必须
 * 保证钩子绝对不抛异常（否则一行日志就能把整个进程带下去），所以 `ingest()` 整体 try/catch。
 *
 * 日志仍然是**实时打到终端**的：钩子只「旁听」，不改写、不吞掉任何字节。
 */

/** 归一化后的级别名（pino 的数字级别在前端不好看）。 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  /** 单调递增，前端用它做增量拉取（`?after=<id>`）与去重。 */
  id: number;
  /** 毫秒时间戳。 */
  time: number;
  level: LogLevel;
  stream: 'stdout' | 'stderr';
  text: string;
}

/** 内存里保留多少条。1000 条足够翻回来看，也不至于把内存撑起来。 */
const MAX_ENTRIES = 1000;

/** 单行最多保留多少字符（防止某个巨大的 JSON 把整块缓冲挤爆）。 */
const MAX_LINE = 4000;

const entries: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

/** 用单调计数器而不是 `entries.length`：清空后 id 仍然往前走，前端不会重复消费。 */
let nextId = 1;
let installed = false;

const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 把 pino 的 JSON 行压成一行人话。
 *
 * Fastify 的请求日志形如 `{"level":30,"time":…,"msg":"incoming request","req":{"method":"GET"…}}`，
 * 直接摊在控制台上全是引号和大括号，看不清。这里只挑最要紧的几个字段拼起来；
 * 认不出来的结构就退回原样输出，宁可难看也不要丢信息。
 */
function formatPino(payload: Record<string, unknown>): string {
  const parts: string[] = [];

  if (typeof payload.msg === 'string' && payload.msg.length > 0) parts.push(payload.msg);

  const { req, res, err, error } = payload;
  if (isRecord(req)) {
    const method = typeof req.method === 'string' ? req.method : '';
    const url = typeof req.url === 'string' ? req.url : '';
    const line = `${method} ${url}`.trim();
    if (line) parts.push(line);
  }
  if (isRecord(res) && typeof res.statusCode === 'number') {
    parts.push(`→ ${res.statusCode}`);
  }
  if (typeof payload.responseTime === 'number') {
    parts.push(`${Math.round(payload.responseTime)}ms`);
  }
  if (isRecord(err) && typeof err.message === 'string') {
    parts.push(err.message);
  } else if (isRecord(error) && typeof error.message === 'string') {
    parts.push(error.message);
  } else if (typeof error === 'string') {
    parts.push(error);
  }

  const text = parts.join(' · ');
  // 只有 level/time 没有 msg 的裸日志（例如 pino 的启动信息）也别丢。
  return text || JSON.stringify(payload);
}

interface Ingested {
  level: LogLevel;
  text: string;
  time?: number;
}

function interpret(stream: 'stdout' | 'stderr', line: string): Ingested {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && (typeof parsed.msg === 'string' || typeof parsed.level === 'number')) {
        const level =
          typeof parsed.level === 'number' ? (PINO_LEVELS[parsed.level] ?? 'info') : 'info';
        return {
          level,
          text: formatPino(parsed),
          time: typeof parsed.time === 'number' ? parsed.time : undefined,
        };
      }
    } catch {
      // 不是合法 JSON：当普通文本处理。
    }
  }
  return { level: stream === 'stderr' ? 'warn' : 'info', text: line };
}

function push(entry: LogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  for (const listener of listeners) {
    // 单个订阅者（一个 SSE 连接）出错不能影响别人，更不能影响主流程。
    try {
      listener(entry);
    } catch {
      /* ignore */
    }
  }
}

/** 两条流各自缓存半行：write 的边界不保证在换行处。 */
const partials: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };

function ingest(stream: 'stdout' | 'stderr', chunk: unknown): void {
  const raw = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const combined = partials[stream] + raw;
  const lines = combined.split('\n');
  // 最后一段可能没写完，留到下一次 write 再拼。
  partials[stream] = lines.pop() ?? '';

  for (const line of lines) {
    if (line.length === 0) continue;
    const { level, text, time } = interpret(stream, line.slice(0, MAX_LINE));
    push({ id: nextId++, time: time ?? Date.now(), level, stream, text });
  }
}

type WriteFn = (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;

function patchStream(stream: NodeJS.WriteStream, name: 'stdout' | 'stderr'): void {
  const original = stream.write.bind(stream) as unknown as WriteFn;
  const patched = (chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    try {
      ingest(name, chunk);
    } catch {
      // 缓冲区自身的问题不许打断正常输出。
    }
    return original(chunk, encoding, callback);
  };
  stream.write = patched as unknown as typeof stream.write;
}

/**
 * 装上钩子（幂等）。必须在创建 Fastify 实例**之前**调用，否则启动那几条日志抓不到。
 */
export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  patchStream(process.stdout, 'stdout');
  patchStream(process.stderr, 'stderr');
}

/** 取最近的日志；`after` 用于 SSE 重连后补齐断档。 */
export function recentLogs(limit = 200, after = 0): LogEntry[] {
  const filtered = after > 0 ? entries.filter((entry) => entry.id > after) : entries;
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export function clearLogs(): void {
  entries.length = 0;
}

/**
 * 订阅新日志，返回取消订阅的函数。
 *
 * 顺序很关键：**先订阅、再取快照**才不会漏掉两者之间的日志（宁可重复，前端按 id 去重）。
 */
export function subscribeLogs(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 进程状态快照，给控制台顶部的仪表用。
 *
 * `startedAt` 取模块加载时间：它和进程真正起来只差几十毫秒，但比 `process.uptime()`
 * 更容易在前端算「已运行多久」。
 */
export interface ServerStats {
  pid: number;
  node: string;
  platform: string;
  startedAt: number;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  logCount: number;
}

const startedAt = Date.now();

export function serverStats(): ServerStats {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    logCount: entries.length,
  };
}

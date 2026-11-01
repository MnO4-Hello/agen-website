/**
 * 解一道工作量证明题（ALTCHA / Cap 同款思路）。
 *
 * 题目形如：`sha256(salt + number) === challenge`，`number ∈ [0, maxnumber]`。
 * 因为哈希不可逆，只能从 0 开始逐个试——平均试一半，服务端一次哈希就能验完。
 *
 * 两个实现要点：
 *
 *   1. **分块让出主线程**。十五万次哈希同步跑完会让页面卡住、进度条不动，看起来像
 *      死了。每 8000 次 `await` 一次，浏览器才有机会重绘。（不引 Worker：为一个
 *      一次性任务加一条 worker 通道，收益不如这点延迟。）
 *   2. **逐字比较，不拼十六进制**。单个候选只要和目标的 8 个 32 位字比一遍；把摘要
 *      拼成 64 个字符再比，会让耗时翻三倍。
 */

import { sha256Words } from './sha256';
import type { Challenge, Puzzle, Solution } from './types';

/**
 * 每算这么多次让出一次主线程。
 *
 * `setTimeout(0)` 实际会被浏览器钳到 ~4ms，所以这个值不能太小：8000 一块时，50 万次要
 * 让出 62 次，光等待就白搭 250ms。25000 一块（约 20 次）既够进度条动，又不至于把时间
 * 耗在等待上。
 */
const CHUNK = 25_000;

export interface SolveOptions {
  signal?: AbortSignal;
  /** 0~100。用来自绘进度条——它不是精确的科学计数，只是「大概到哪了」。 */
  onProgress?: (percent: number) => void;
}

const sleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function parseWords(hex: string): Uint32Array | null {
  if (hex.length !== 64) return null;
  const words = new Uint32Array(8);
  for (let i = 0; i < 8; i += 1) {
    const value = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16);
    if (!Number.isFinite(value)) return null;
    words[i] = value >>> 0;
  }
  return words;
}

export async function solvePuzzle(
  puzzle: Challenge,
  options: SolveOptions = {},
): Promise<Solution> {
  const target = parseWords(puzzle.challenge);
  if (!target) throw new Error('pow_bad_challenge');

  const digest = new Uint32Array(8);
  const started = Date.now();
  const max = Math.max(0, Math.trunc(puzzle.maxnumber));

  const solved = (): boolean =>
    digest[0] === target[0] &&
    digest[1] === target[1] &&
    digest[2] === target[2] &&
    digest[3] === target[3] &&
    digest[4] === target[4] &&
    digest[5] === target[5] &&
    digest[6] === target[6] &&
    digest[7] === target[7];

  for (let base = 0; base <= max; base += CHUNK) {
    const end = Math.min(max, base + CHUNK - 1);
    for (let number = base; number <= end; number += 1) {
      sha256Words(`${puzzle.salt}${number}`, digest);
      if (solved()) {
        options.onProgress?.(100);
        const solution: Puzzle & { number: number; took: number } = {
          algorithm: puzzle.algorithm,
          challenge: puzzle.challenge,
          salt: puzzle.salt,
          signature: puzzle.signature,
          maxnumber: puzzle.maxnumber,
          number,
          took: Date.now() - started,
        };
        return solution;
      }
    }

    options.onProgress?.(max === 0 ? 100 : Math.min(99, Math.round((end / max) * 100)));
    // 先让出，再检查取消：这样 abort 时不会把当前这一块算完才停。
    await sleep();
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }

  // 走到这里说明题面与 maxnumber 不匹配（正常不会发生），交给上层重新领题。
  throw new Error('pow_no_solution');
}

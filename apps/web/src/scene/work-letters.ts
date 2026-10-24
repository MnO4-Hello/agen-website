/**
 * 「W O R K」字母的幽灵阵列——参考站 `s-work` 里最标志性的一招。
 *
 * 参考站 HTML 里只有 4 个字母，跑马灯是**运行期复制出来的**：把每个字母复制
 * `round(视口宽 / 字宽 * 0.75) + 2` 份，全部摆在与原字母**同一个位置**，然后靠
 * 每份不同的 `--progress` 在 CSS 里把它们拉开：
 *
 *   --head  = (progress − 0.5) × −2
 *   --ahead = head²
 *   transform: rotateY(head × −10deg × state)
 *              translate3d(head × 50vw × state, iy × 50% × ahead × state, 0)
 *
 * 于是 `--state`（由时间轴驱动）是唯一的开关：
 *   - `state = 0`：所有幽灵的位移乘以 0 —— 全部叠回原位，看起来就是那四个字；
 *   - `state = 1`：幽灵按各自的 `--progress` 向两侧炸开，`rotateY` 让它们转出 3D
 *     纵深，叠成一条横向流动的跑马灯。
 *
 * 每帧改的只有 `--progress` 一个变量（`moveLetters()`），所以整套是纯合成层动画。
 */

/**
 * 幽灵密度。
 *
 * 参考站这里写的是 0.75，但**那个常数是为它自己那套 Bigger Display 调的**：那是一个
 * 极窄的压缩体（字面宽 ≈0.25em），0.75 摊下来每个字母铺 ~20 份，同屏稳定看到 13~14
 * 个，连成一面墙。我们自托管的 Archivo Narrow 字面宽得多（W ≈0.77em、O ≈0.66em），
 * 照抄 0.75 只能铺出 ~10 份、同屏 7 个——跑马灯一下子散成了格子，这正是「效果差得远」
 * 最直观的一处。
 *
 * 所以这里按**实测目标**校准，而不是照抄常数：让同屏字数回到 13~14（与参考站在
 * 1440 宽下的实测一致，字距 ≈100px）。幽灵份数 `total = round(vw / 字宽 × 密度) + 2`，
 * 而字距 ∝ 1 / total，所以密度翻倍字距就减半。
 */
const DENSITY_DESKTOP = 1.45;
const DENSITY_COMPACT = 1;

/** `--progress` 的映射：先归一到 [0,1) 再拉伸，末尾留一段让幽灵从屏幕外进场。 */
const PROGRESS_SPAN = 0.7;
const PROGRESS_OFFSET = 0.15;

interface Ghost {
  readonly el: HTMLSpanElement;
}

interface LetterTrack {
  readonly el: HTMLElement;
  readonly glyph: string;
  freq: number;
  total: number;
  ghosts: Ghost[];
}

export interface WorkLettersHandle {
  /** 量一次原生字母的位置，重建整片幽灵。resize 后要重新调用。 */
  build(): void;
  /** 每帧推一次 `animationProgress`（时间轴里的 `this.animationProgress`）。 */
  update(animationProgress: number): void;
  dispose(): void;
}

export interface WorkLettersOptions {
  /** `.s__scene`，幽灵挂在这里。 */
  readonly scene: HTMLElement;
  /** `.js-title` 容器，里面是那 4 个原生字母。 */
  readonly title: HTMLElement;
  /** `.s__inner`，用来把视口坐标换算成场景内坐标。 */
  readonly container: HTMLElement;
  /** 字母选择器。 */
  readonly letterSelector?: string;
}

export function createWorkLetters(options: WorkLettersOptions): WorkLettersHandle {
  const { scene, title, container } = options;
  const selector = options.letterSelector ?? '.s__title__letter';

  const nativeLetters = Array.from(title.querySelectorAll<HTMLElement>(selector));
  const tracks: LetterTrack[] = nativeLetters.map((el) => ({
    el,
    glyph: el.textContent?.trim() || 'W',
    freq: 1,
    total: 0,
    ghosts: [],
  }));

  /** `hypot(视口宽, 视口高) × 4`——参考站用它当跑马灯的基础“速度”。 */
  let speed = 1;

  const build = (): void => {
    // 参考站 `setSize()` 里 `bounding` 的宽高取的是 `window.safeWidth/safeHeight`
    // （即 innerWidth / innerHeight），只有 `top` 来自容器的 rect。照抄，
    // 这样幽灵份数只跟视口宽度和字宽有关，与容器是否恰好撑满无关。
    const containerTop = container.getBoundingClientRect().top;
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    speed = Math.hypot(viewportWidth, viewportHeight) * 4;

    const density = viewportWidth > 767 ? DENSITY_DESKTOP : DENSITY_COMPACT;

    tracks.forEach((track, letterIndex) => {
      // 先清干净：resize 会反复重建，不能叠加。
      for (const ghost of track.ghosts) ghost.el.remove();
      track.ghosts = [];

      const rect = track.el.getBoundingClientRect();
      const letterWidth = Math.max(1, rect.width);
      // 视口坐标 → 场景坐标（`.s__scene` 与 `.s__inner` 同原点，都铺满一屏）。
      const top = rect.top - containerTop;
      const left = rect.left;

      track.freq = 1 + Math.random();
      track.total = Math.round((viewportWidth / letterWidth) * density) + 2;

      for (let index = 0; index < track.total; index += 1) {
        const ghost = document.createElement('span');
        ghost.className = 's__scene__letter';
        ghost.textContent = track.glyph;
        ghost.dataset.letter = track.glyph;

        ghost.style.top = `${top}px`;
        ghost.style.left = `${left}px`;
        // 少量幽灵提到上层，让叠出来的字有前后层次（参考站的做法）。
        const lift = letterIndex !== 1 && letterIndex !== 2 && (letterIndex + nativeLetters.length + index) % 5 === 0;
        ghost.style.zIndex = lift ? '3' : '1';

        // 这几个变量参考站也写了；CSS 里当前没消费，但留着以便按需扩展。
        ghost.style.setProperty('--ix', String(index - track.total * 0.5));
        ghost.style.setProperty('--iy', String(((letterIndex + 1) / (nativeLetters.length + 1) - 0.5) * 2));
        ghost.style.setProperty('--ap', String(Math.abs(index / track.total - 0.5) * 2));
        ghost.style.setProperty('--p', String((index / track.total - 0.5) * 2));

        scene.append(ghost);
        track.ghosts.push({ el: ghost });
      }
    });
  };

  const update = (animationProgress: number): void => {
    for (const track of tracks) {
      const period = speed * track.freq;
      if (!Number.isFinite(period) || period <= 0) continue;
      for (let index = 0; index < track.ghosts.length; index += 1) {
        const raw = animationProgress % period;
        const value = ((raw / period + index / track.total) % 1) / PROGRESS_SPAN - PROGRESS_OFFSET;
        track.ghosts[index]?.el.style.setProperty('--progress', value.toFixed(4));
      }
    }
  };

  return {
    build,
    update,
    dispose: () => {
      for (const track of tracks) {
        for (const ghost of track.ghosts) ghost.el.remove();
        track.ghosts = [];
      }
    },
  };
}

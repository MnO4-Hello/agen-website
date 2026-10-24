/**
 * 把头像照片转成揭示动画需要的“有序点阵”。
 *
 * 先把照片画进一张离屏方图，再按固定的网格切开。每个格子只保留一颗最能代表
 * 它的像素：离该格平均色最远的那颗。这样颜色会落在细节上（轮廓、高光）而不是
 * 大片纯色背景上；同时因为每格最多出一个点，这些点在视觉上天生就是“一行一列”
 * 排好的——正是后面让它们先排成像素方块、再翻面露出照片的前提。
 */

/** 点阵所用的设计坐标系边长（px）。真实尺寸按画布宽度等比换算。 */
export const PORTRAIT_DESIGN = 520;

export interface PortraitPoint {
  /** 设计坐标（左上角为原点），即格心。 */
  x: number;
  y: number;
  /** 该格的代表色通道（0-255）。 */
  r: number;
  g: number;
  b: number;
}

export interface PortraitGrid {
  points: readonly PortraitPoint[];
  /** 网格间距（设计坐标 px），等于一个格子的边长。 */
  gap: number;
}

/**
 * 采样失败（图片跨域、无法解码等）时返回空点阵，调用方退化成只显示照片，
 * 而不是让整个板块报错。
 */
export async function samplePortraitGrid(
  image: HTMLImageElement,
  size: number,
  gap: number,
): Promise<PortraitGrid> {
  if (!image.complete) {
    await image.decode().catch(() => undefined);
  }
  if (!image.naturalWidth) return { points: [], gap };

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return { points: [], gap };

  context.drawImage(image, 0, 0, size, size);

  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, size, size).data;
  } catch {
    // 跨域图片会污染画布，这里直接放弃采样。
    return { points: [], gap };
  }

  const cols = Math.max(1, Math.round(PORTRAIT_DESIGN / gap));
  const cell = size / cols;
  const points: PortraitPoint[] = [];

  for (let row = 0; row < cols; row += 1) {
    const y0 = Math.floor(row * cell);
    const y1 = Math.max(y0 + 1, Math.min(size, Math.ceil((row + 1) * cell)));

    for (let col = 0; col < cols; col += 1) {
      const x0 = Math.floor(col * cell);
      const x1 = Math.max(x0 + 1, Math.min(size, Math.ceil((col + 1) * cell)));

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let count = 0;

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * size + x) * 4;
          sumR += data[index];
          sumG += data[index + 1];
          sumB += data[index + 2];
          count += 1;
        }
      }
      if (count === 0) continue;

      const meanR = sumR / count;
      const meanG = sumG / count;
      const meanB = sumB / count;

      let best = -1;
      let bestR = Math.round(meanR);
      let bestG = Math.round(meanG);
      let bestB = Math.round(meanB);

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * size + x) * 4;
          const dr = data[index] - meanR;
          const dg = data[index + 1] - meanG;
          const db = data[index + 2] - meanB;
          const distance = dr * dr + dg * dg + db * db;
          if (distance > best) {
            best = distance;
            bestR = data[index];
            bestG = data[index + 1];
            bestB = data[index + 2];
          }
        }
      }

      points.push({
        x: ((col + 0.5) / cols) * PORTRAIT_DESIGN,
        y: ((row + 0.5) / cols) * PORTRAIT_DESIGN,
        r: bestR,
        g: bestG,
        b: bestB,
      });
    }
  }

  return { points, gap };
}

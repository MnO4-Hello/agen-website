/**
 * Geometry and palette for the maple leaves in the hero scene.
 *
 * Shapes are generated once as normalised point rings (longest tip on radius 1)
 * so the render loop only has to scale and rotate plain numbers instead of
 * rebuilding bezier paths every frame.
 */

export interface LeafShape {
  /** Flat [x0, y0, x1, y1, ...] ring, closed by the renderer. */
  readonly points: readonly number[];
}

export interface LeafPaletteEntry {
  readonly fill: string;
  readonly stroke: string;
}

/** Warm autumn colours, picked to read clearly on the pale green background. */
export const LEAF_PALETTE: readonly LeafPaletteEntry[] = [
  { fill: '#c0522c', stroke: '#8d3a1e' },
  { fill: '#d0742f', stroke: '#96501c' },
  { fill: '#b23f2a', stroke: '#7f2a1b' },
  { fill: '#cc8a3c', stroke: '#92612a' },
  { fill: '#a03a28', stroke: '#722619' },
  { fill: '#c9662c', stroke: '#8d451d' },
  { fill: '#d8a34a', stroke: '#9b7130' },
];

export function createLeafShapes(count = 12, random: () => number = Math.random): LeafShape[] {
  return Array.from({ length: count }, () => generateShape(random));
}

function generateShape(random: () => number): LeafShape {
  const lobes = random() < 0.72 ? 5 : 7;
  const notchRadius = 0.44 + random() * 0.1;
  const tipRadius = 0.92 + random() * 0.14;
  const verticalSquash = 0.92 + random() * 0.16;
  const steps = lobes * 14;
  const points: number[] = [];
  let max = 0;

  for (let index = 0; index < steps; index += 1) {
    const theta = (index / steps) * Math.PI * 2;
    // Rose curve: `lobes` pointed tips separated by soft notches.
    const wave = Math.abs(Math.cos((lobes / 2) * (theta + Math.PI / 2)));
    const radius =
      notchRadius + (tipRadius - notchRadius) * Math.pow(wave, 1.35) + (random() - 0.5) * 0.03;
    const x = Math.cos(theta) * radius;
    const y = Math.sin(theta) * radius * verticalSquash;
    points.push(x, y);
    max = Math.max(max, Math.hypot(x, y));
  }

  for (let index = 0; index < points.length; index += 1) {
    points[index] /= max;
  }
  return { points };
}

export function traceLeaf(
  context: CanvasRenderingContext2D,
  shape: LeafShape,
  radius: number,
): void {
  const points = shape.points;
  context.beginPath();
  context.moveTo(points[0] * radius, points[1] * radius);
  for (let index = 2; index < points.length; index += 2) {
    context.lineTo(points[index] * radius, points[index + 1] * radius);
  }
  context.closePath();
}

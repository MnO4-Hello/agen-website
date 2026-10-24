/**
 * Integration and collision for a single falling maple leaf.
 *
 * Leaves live in viewport (screen) space. Every frame the caller feeds in the
 * current screen-space boxes of the page elements they should collide with, so
 * scrolling content moves through the leaves and knocks them around instead of
 * carrying them along.
 */

export interface Collider {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Screen-space velocity in px/s, so moving content can strike a leaf. */
  vx: number;
  vy: number;
  active: boolean;
}

export interface Leaf {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  depth: number;
  shapeIndex: number;
  paletteIndex: number;
  rotation: number;
  spin: number;
  flutter: number;
  flutterSpeed: number;
  swayPhase: number;
  swaySpeed: number;
  swayAmplitude: number;
  breezePhase: number;
  appear: number;
  opacity: number;
  resting: boolean;
  restTimer: number;
  fadeTimer: number | null;
  dead: boolean;
}

export interface LeafInit {
  x: number;
  y: number;
  size: number;
  depth: number;
  shapeIndex: number;
  paletteIndex: number;
}

export interface StepContext {
  dt: number;
  time: number;
  width: number;
  height: number;
  colliders: readonly Collider[];
  breezeAmplitude: number;
}

const GRAVITY = 1400;
const VERTICAL_DRAG = 2.6;
const HORIZONTAL_DRAG = 1;
const MAX_SPEED = 2400;
const MAX_BOUNCE = 900;
const REST_LIFE = 6.5;
const FADE_TIME = 2.4;
/** Collider speed (px/s) that shakes a settled leaf loose again. */
const REST_WAKE_SPEED = 6;

export function createLeaf(init: LeafInit): Leaf {
  const depthScale = 0.8 + init.depth * 0.6;
  return {
    x: init.x,
    y: init.y,
    vx: (Math.random() - 0.5) * 40,
    vy: 20 + Math.random() * 60,
    size: init.size,
    depth: init.depth,
    shapeIndex: init.shapeIndex,
    paletteIndex: init.paletteIndex,
    rotation: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 2.4,
    flutter: Math.random() * Math.PI * 2,
    flutterSpeed: (1.1 + Math.random() * 1.7) * depthScale,
    swayPhase: Math.random() * Math.PI * 2,
    swaySpeed: 0.8 + Math.random() * 1.4,
    swayAmplitude: (40 + Math.random() * 90) / depthScale,
    breezePhase: Math.random() * Math.PI * 2,
    appear: 0,
    opacity: 0,
    resting: false,
    restTimer: 0,
    fadeTimer: null,
    dead: false,
  };
}

export function stepLeaf(leaf: Leaf, context: StepContext): void {
  const dt = context.dt;

  if (leaf.appear < 1) {
    leaf.appear = Math.min(1, leaf.appear + dt / 0.5);
  }

  if (leaf.fadeTimer !== null) {
    leaf.fadeTimer += dt;
    if (leaf.fadeTimer >= FADE_TIME) {
      leaf.dead = true;
      return;
    }
  }

  if (leaf.resting) {
    leaf.restTimer += dt;
    if (leaf.fadeTimer === null && leaf.restTimer >= REST_LIFE) {
      leaf.fadeTimer = 0;
    }
    leaf.vy = 0;
    leaf.vx *= Math.exp(-7 * dt);
    leaf.x += leaf.vx * dt;
  } else {
    leaf.vy = leaf.vy * Math.exp(-VERTICAL_DRAG * dt) + GRAVITY * dt;
    leaf.vx *= Math.exp(-HORIZONTAL_DRAG * dt);
    leaf.swayPhase += leaf.swaySpeed * dt;
    leaf.vx +=
      (Math.sin(leaf.swayPhase) * leaf.swayAmplitude +
        context.breezeAmplitude * Math.sin(context.time * 0.65 + leaf.breezePhase)) *
      dt;

    const speed = Math.hypot(leaf.vx, leaf.vy);
    if (speed > MAX_SPEED) {
      const scale = MAX_SPEED / speed;
      leaf.vx *= scale;
      leaf.vy *= scale;
    }
    leaf.x += leaf.vx * dt;
    leaf.y += leaf.vy * dt;
  }

  leaf.rotation += leaf.spin * dt;
  leaf.flutter += leaf.flutterSpeed * dt;

  resolveCollisions(leaf, context);

  if (leaf.x < -leaf.size * 2) {
    leaf.x = context.width + leaf.size;
  } else if (leaf.x > context.width + leaf.size * 2) {
    leaf.x = -leaf.size;
  }

  if (leaf.y - leaf.size > context.height + 60) {
    leaf.dead = true;
    return;
  }

  const baseOpacity = 0.5 + leaf.depth * 0.5;
  const fade = leaf.fadeTimer === null ? 1 : Math.max(0, 1 - leaf.fadeTimer / FADE_TIME);
  leaf.opacity = baseOpacity * leaf.appear * fade;
}

function resolveCollisions(leaf: Leaf, context: StepContext): void {
  const radius = leaf.size * 0.5;
  let topContact = false;

  for (const collider of context.colliders) {
    if (!collider.active) continue;
    if (
      leaf.x + radius < collider.left ||
      leaf.x - radius > collider.right ||
      leaf.y + radius < collider.top ||
      leaf.y - radius > collider.bottom
    ) {
      continue;
    }

    const closestX = Math.min(Math.max(leaf.x, collider.left), collider.right);
    const closestY = Math.min(Math.max(leaf.y, collider.top), collider.bottom);
    let normalX = leaf.x - closestX;
    let normalY = leaf.y - closestY;
    const distance = Math.hypot(normalX, normalY);
    let penetration: number;

    if (distance > 0.0001) {
      normalX /= distance;
      normalY /= distance;
      penetration = radius - distance;
    } else {
      // Centre is inside the box: escape along the shallowest axis.
      const toLeft = leaf.x - collider.left;
      const toRight = collider.right - leaf.x;
      const toTop = leaf.y - collider.top;
      const toBottom = collider.bottom - leaf.y;
      const smallest = Math.min(toLeft, toRight, toTop, toBottom);
      if (smallest === toTop) {
        normalX = 0;
        normalY = -1;
        penetration = toTop + radius;
      } else if (smallest === toBottom) {
        normalX = 0;
        normalY = 1;
        penetration = toBottom + radius;
      } else if (smallest === toLeft) {
        normalX = -1;
        normalY = 0;
        penetration = toLeft + radius;
      } else {
        normalX = 1;
        normalY = 0;
        penetration = toRight + radius;
      }
    }

    if (leaf.resting && Math.abs(collider.vy) > REST_WAKE_SPEED) {
      leaf.resting = false;
      leaf.restTimer = 0;
      leaf.vy = Math.max(Math.min(collider.vy, 0) * 0.45, -MAX_BOUNCE);
      leaf.vx += (Math.random() - 0.5) * 110;
      leaf.spin += (Math.random() - 0.5) * 3.5;
    }

    leaf.x += normalX * penetration;
    leaf.y += normalY * penetration;

    const landingOnTop = normalY < -0.6;
    const velocityAlongNormal = leaf.vx * normalX + leaf.vy * normalY;
    if (velocityAlongNormal < 0) {
      const restitution = landingOnTop ? 0.05 : 0.3;
      leaf.vx -= (1 + restitution) * velocityAlongNormal * normalX;
      leaf.vy -= (1 + restitution) * velocityAlongNormal * normalY;

      const tangentX = -normalY;
      const tangentY = normalX;
      const tangentSpeed = leaf.vx * tangentX + leaf.vy * tangentY;
      const friction = landingOnTop ? 0.5 : 0.15;
      leaf.vx -= tangentSpeed * tangentX * friction;
      leaf.vy -= tangentSpeed * tangentY * friction;
    }

    if (landingOnTop) topContact = true;
  }

  if (topContact && Math.abs(leaf.vy) < 90 && Math.abs(leaf.vx) < 170) {
    if (!leaf.resting) {
      leaf.resting = true;
      leaf.restTimer = 0;
    }
    leaf.vy = 0;
    leaf.vx *= 0.45;
  } else if (leaf.resting && !topContact) {
    // Support scrolled away, so the leaf is free to fall again.
    leaf.resting = false;
    leaf.restTimer = 0;
  }
}

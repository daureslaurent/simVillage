/**
 * client/src/villagerSprite.ts
 * ---------------------------------------------------------------------------
 * Draws a villager as a little LAYERED FIGURE on the canvas — a body silhouette,
 * a head with hair, optional headwear, and a small held tool — from the
 * enumerated {@link VillagerAppearance} parts the world generator assigns. The
 * result is that no two villagers look alike at a glance, far richer than the
 * old flat coloured dot, while staying cheap vector drawing that scales with the
 * viewport's zoom.
 *
 * Everything is sized relative to a single `r` (the body "radius" in pixels) and
 * centred on the villager's torso point, so the caller can keep treating that
 * point as the villager's location for cards, bubbles and selection rings.
 * ---------------------------------------------------------------------------
 */

import type { VillagerAppearance } from '../../shared/appearance';

const OUTLINE = 'rgba(13, 17, 23, 0.85)';

/** Tool colours, by part — so the model need not pick a colour for the prop. */
const WOOD = '#8b5a2b';
const METAL = '#c9d1d9';

/** A rounded rectangle path (falls back to a plain rect on very old canvases). */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rad: number): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rad);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/**
 * Render the villager figure centred on `(x, y)` with body size `r`. `opts.dim`
 * fades a sleeping villager; `outline` width tracks `r` so the figure reads at
 * any zoom.
 */
export function drawVillagerSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  app: VillagerAppearance,
  opts: { dim?: boolean } = {},
): void {
  ctx.save();
  if (opts.dim) ctx.globalAlpha *= 0.55;
  const lw = Math.max(1, r * 0.16);

  // Soft contact shadow, so the figure sits on the ground rather than floating.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.9, r * 0.95, r * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();

  // The held tool is drawn FIRST, behind the body, so the body overlaps the grip.
  drawAccent(ctx, x, y, r, app.accent);

  // 1. Body silhouette.
  ctx.fillStyle = app.bodyColor;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = lw;
  bodyPath(ctx, x, y, r, app.body);
  ctx.fill();
  ctx.stroke();

  // 2. Head — a skin-toned disc resting on the shoulders.
  const hy = y - r * 0.92;
  const hr = r * 0.6;
  ctx.fillStyle = app.skin;
  ctx.beginPath();
  ctx.arc(x, hy, hr, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 3. Hair, then 4. hat over it.
  drawHair(ctx, x, hy, hr, app.hair, app.hairColor);
  drawHat(ctx, x, hy, hr, app.hat, app.bodyColor);

  ctx.restore();
}

/** Lay down the body path for the chosen silhouette (caller fills + strokes). */
function bodyPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, body: VillagerAppearance['body']): void {
  switch (body) {
    case 'square':
      roundRect(ctx, x - r * 0.86, y - r * 0.86, r * 1.72, r * 1.72, r * 0.34);
      break;
    case 'tall':
      roundRect(ctx, x - r * 0.62, y - r * 0.95, r * 1.24, r * 1.95, r * 0.55);
      break;
    case 'stout':
      roundRect(ctx, x - r * 1.05, y - r * 0.6, r * 2.1, r * 1.4, r * 0.6);
      break;
    case 'round':
    default:
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      break;
  }
}

/** Hair sitting over the top/back of the head. */
function drawHair(
  ctx: CanvasRenderingContext2D,
  x: number,
  hy: number,
  hr: number,
  hair: VillagerAppearance['hair'],
  color: string,
): void {
  if (hair === 'bald') return;
  ctx.fillStyle = color;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1, hr * 0.16);

  // A skull-cap of hair over the upper head, shared by every non-bald style.
  ctx.beginPath();
  ctx.arc(x, hy, hr * 1.04, Math.PI * 0.92, Math.PI * 2.08);
  ctx.fill();

  switch (hair) {
    case 'long': {
      // Two locks running down past the jaw on each side.
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(x + s * hr * 0.92, hy + hr * 0.5, hr * 0.34, hr * 1.0, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'bun': {
      ctx.beginPath();
      ctx.arc(x, hy - hr * 1.05, hr * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'spiky': {
      ctx.beginPath();
      for (let i = -2; i <= 2; i++) {
        const px = x + i * hr * 0.42;
        ctx.moveTo(px - hr * 0.22, hy - hr * 0.7);
        ctx.lineTo(px, hy - hr * 1.35);
        ctx.lineTo(px + hr * 0.22, hy - hr * 0.7);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    // 'short' is just the skull-cap drawn above.
    default:
      break;
  }
}

/** Headwear over the hair. */
function drawHat(
  ctx: CanvasRenderingContext2D,
  x: number,
  hy: number,
  hr: number,
  hat: VillagerAppearance['hat'],
  bodyColor: string,
): void {
  if (hat === 'none') return;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1, hr * 0.16);

  switch (hat) {
    case 'straw': {
      ctx.fillStyle = '#d9b86a';
      // Brim.
      ctx.beginPath();
      ctx.ellipse(x, hy - hr * 0.55, hr * 1.5, hr * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Low dome.
      ctx.beginPath();
      ctx.ellipse(x, hy - hr * 0.78, hr * 0.72, hr * 0.5, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'cap': {
      ctx.fillStyle = '#3a6ea5';
      ctx.beginPath();
      ctx.arc(x, hy - hr * 0.2, hr * 1.02, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Front peak.
      ctx.beginPath();
      ctx.ellipse(x + hr * 0.7, hy - hr * 0.2, hr * 0.7, hr * 0.22, 0, 0, Math.PI);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'hood': {
      ctx.fillStyle = shade(bodyColor, -0.28);
      ctx.beginPath();
      ctx.arc(x, hy - hr * 0.05, hr * 1.28, Math.PI * 0.78, Math.PI * 2.22);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'crown': {
      ctx.fillStyle = '#ffd24d';
      const top = hy - hr * 0.95;
      const base = hy - hr * 0.45;
      ctx.beginPath();
      ctx.moveTo(x - hr * 0.9, base);
      for (let i = 0; i <= 4; i++) {
        const px = x - hr * 0.9 + (i / 4) * hr * 1.8;
        ctx.lineTo(px, i % 2 === 0 ? top : base - hr * 0.05);
      }
      ctx.lineTo(x + hr * 0.9, base);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'wreath': {
      ctx.fillStyle = '#3fa34d';
      for (let i = 0; i < 7; i++) {
        const a = Math.PI + (i / 6) * Math.PI;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * hr * 1.05, hy - hr * 0.5 + Math.sin(a) * hr * 0.5, hr * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'horns': {
      ctx.fillStyle = '#e8e2d0';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + s * hr * 0.55, hy - hr * 0.55);
        ctx.quadraticCurveTo(x + s * hr * 1.3, hy - hr * 1.0, x + s * hr * 1.05, hy - hr * 1.6);
        ctx.quadraticCurveTo(x + s * hr * 0.85, hy - hr * 1.0, x + s * hr * 0.25, hy - hr * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
}

/** A small tool held at the figure's right side, hinting at its role. */
function drawAccent(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  accent: VillagerAppearance['accent'],
): void {
  if (accent === 'none') return;
  const gx = x + r * 1.05; // grip x, just off the body's right side
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = Math.max(1, r * 0.12);

  const shaft = (topColor: string) => {
    ctx.strokeStyle = WOOD;
    ctx.lineWidth = Math.max(1.5, r * 0.2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gx, y + r * 0.9);
    ctx.lineTo(gx, y - r * 1.5);
    ctx.stroke();
    ctx.lineCap = 'butt';
    return topColor;
  };

  switch (accent) {
    case 'staff': {
      shaft(METAL);
      ctx.fillStyle = '#ffd24d';
      ctx.beginPath();
      ctx.arc(gx, y - r * 1.55, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'hoe': {
      shaft(METAL);
      ctx.strokeStyle = METAL;
      ctx.lineWidth = Math.max(1.5, r * 0.22);
      ctx.beginPath();
      ctx.moveTo(gx, y - r * 1.45);
      ctx.lineTo(gx + r * 0.6, y - r * 1.45);
      ctx.stroke();
      break;
    }
    case 'hammer': {
      shaft(METAL);
      ctx.fillStyle = METAL;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, r * 0.1);
      roundRect(ctx, gx - r * 0.34, y - r * 1.7, r * 0.68, r * 0.42, r * 0.08);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'book': {
      ctx.fillStyle = '#c14b2a';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, r * 0.1);
      roundRect(ctx, gx - r * 0.1, y - r * 0.1, r * 0.7, r * 0.9, r * 0.08);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath();
      ctx.moveTo(gx + r * 0.25, y - r * 0.05);
      ctx.lineTo(gx + r * 0.25, y + r * 0.75);
      ctx.stroke();
      break;
    }
    case 'lantern': {
      ctx.strokeStyle = WOOD;
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.beginPath();
      ctx.moveTo(gx, y - r * 0.6);
      ctx.lineTo(gx, y - r * 0.2);
      ctx.stroke();
      const grad = ctx.createRadialGradient(gx, y, 1, gx, y, r * 0.7);
      grad.addColorStop(0, 'rgba(255, 226, 120, 0.95)');
      grad.addColorStop(1, 'rgba(255, 226, 120, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(gx, y, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffd24d';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, r * 0.08);
      roundRect(ctx, gx - r * 0.22, y - r * 0.05, r * 0.44, r * 0.5, r * 0.08);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'basket': {
      ctx.fillStyle = '#b07a3c';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.beginPath();
      ctx.moveTo(gx - r * 0.4, y + r * 0.2);
      ctx.lineTo(gx + r * 0.5, y + r * 0.2);
      ctx.lineTo(gx + r * 0.34, y + r * 0.85);
      ctx.lineTo(gx - r * 0.24, y + r * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(gx + r * 0.05, y + r * 0.2, r * 0.45, r * 0.16, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
      break;
    }
    default:
      break;
  }
}

/** Darken (`amt<0`) or lighten (`amt>0`) a #rgb/#rrggbb colour for shading. */
function shade(hex: string, amt: number): string {
  const m = hex.trim().replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hex;
  const adj = (c: number) => Math.max(0, Math.min(255, Math.round(c + 255 * amt)));
  const rr = adj((n >> 16) & 0xff);
  const gg = adj((n >> 8) & 0xff);
  const bb = adj(n & 0xff);
  return `#${((rr << 16) | (gg << 8) | bb).toString(16).padStart(6, '0')}`;
}

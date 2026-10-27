import { RULES } from '../engine/data';
import type { Square } from '../engine/types';

const ICONS: Record<string, string> = {
  newYear: '🎆',
  event: '❓',
  disaster: '⚠️',
  airport: '✈️',
  highway: '🛣️',
  tax: '💰',
  city: '🏙️',
};

export function tileIcon(sq: Square) {
  if (sq.type === 'utility') return RULES.utilities.kinds.find((k) => k.id === sq.utility)!.icon;
  return ICONS[sq.type];
}

/** Initials for cities without art: "Cape Town" -> "CT", "Lagos" -> "LAG". */
function initials(name: string) {
  const words = name.split(/\s+/);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 3)).toUpperCase();
}

export function tileArt(sq: Square) {
  if (sq.type === 'city') {
    return sq.image
      ? `<img src="${import.meta.env.BASE_URL}${sq.image}" alt="" loading="lazy" decoding="async" />`
      : `<span class="placeholder" aria-hidden="true">${initials(sq.name)}</span>`;
  }
  return `<span class="icon" aria-hidden="true">${tileIcon(sq)}</span>`;
}

/**
 * Grid cell for a square on an n x n ring (n = size / 4 + 1).
 * New Year sits bottom-right; play runs left along the bottom, up the left, right along the top, down the right.
 */
export function boardPosition(index: number, size: number) {
  const side = size / 4;
  if (index <= side) return { row: side, col: side - index };
  if (index <= side * 2) return { row: side - (index - side), col: 0 };
  if (index <= side * 3) return { row: 0, col: index - side * 2 };
  return { row: index - side * 3, col: side };
}

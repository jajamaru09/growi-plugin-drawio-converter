// src/dom/png-scale.ts
// Persisted PNG export scale selection (1x/2x/3x/4x). Stored in localStorage
// so the user's choice survives reloads.

const STORAGE_KEY = 'drawio-converter.png-scale';
export const VALID_SCALES = [1, 2, 3, 4] as const;
export type PngScale = typeof VALID_SCALES[number];
const DEFAULT_SCALE: PngScale = 2;

function isValidScale(n: number): n is PngScale {
  return (VALID_SCALES as readonly number[]).includes(n);
}

export function getPngScale(): PngScale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SCALE;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && isValidScale(n) ? n : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

export function setPngScale(scale: PngScale): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(scale));
  } catch {
    // ignore quota / privacy-mode errors
  }
}

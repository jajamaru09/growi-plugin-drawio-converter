// src/exporter/export-mode.ts
// Decide whether the PNG click should go through the legacy rasterizer
// (png-legacy/) or the new embed-based path (png-embed/).
//
// Evaluation order: URL query string > localStorage > default (embed).
// - URL query ?drawio-legacy-png=1 / =0  takes precedence (per-tab override)
// - localStorage `drawio-converter.legacyPng` === '1' for persistent override
// - Otherwise: new embed path

const QUERY_PARAM = 'drawio-legacy-png';
const STORAGE_KEY = 'drawio-converter.legacyPng';

export function shouldUseLegacyPng(): boolean {
  try {
    const qs = new URLSearchParams(window.location.search);
    const qv = qs.get(QUERY_PARAM);
    if (qv === '1' || qv === 'true') return true;
    if (qv === '0' || qv === 'false') return false;
  } catch {
    // URLSearchParams should never throw, but be defensive
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

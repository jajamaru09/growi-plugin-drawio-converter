// src/exporter/png-legacy/index.ts
// Legacy PNG rasterizer path. Retained as a manual-switch fallback per
// docs/superpowers/specs/2026-04-24-drawio-native-png-export-design.md.
// Scheduled for removal after 3 months of stable embed-path operation
// (see spec section "将来の削除計画").

export { svgToPng as exportPngLegacy } from './png';
export type { PngOptions as LegacyPngOptions } from './png';

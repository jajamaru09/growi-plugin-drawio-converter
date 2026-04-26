// src/exporter/png-embed/index.ts
// Public entry point for the embed-based PNG export path.
// Combines editor-frame lifecycle, embed-protocol messaging, and the
// serial export queue.
import { log } from '../../logger';
import { getEditorFrame, disposeEditorFrame } from './editor-frame';
import { requestExport, type ExportOpts } from './embed-protocol';
import { enqueue } from './export-queue';
import { inlineSameOriginImagesInXml } from './inline-images';

export { disposeEditorFrame };

export interface EmbedExportOpts {
  scale: number;
  bg: string;
}

// Wall-clock cap for a single export attempt (spec section
// "タイムアウト階層"). Individual stage timeouts inside embed-protocol
// exist only for logging granularity; this is the user-facing cap.
const OVERALL_TIMEOUT_MS = 15000;

// Sub-timeouts passed into embed-protocol. Their sum can exceed the
// overall cap — whichever fires first wins.
const PROTOCOL_TIMEOUTS = {
  load: 5000,
  export: 10000,
};

export function exportPngViaEmbed(xml: string, opts: EmbedExportOpts): Promise<Blob> {
  return enqueue(() => runExportJob(xml, opts));
}

async function runExportJob(xml: string, opts: EmbedExportOpts): Promise<Blob> {
  const jobStart = performance.now();
  let overallTimer: number | undefined;
  const overallDeadline = new Promise<never>((_, reject) => {
    overallTimer = window.setTimeout(() => {
      reject(new Error(`png-embed: overall timeout after ${OVERALL_TIMEOUT_MS}ms`));
    }, OVERALL_TIMEOUT_MS);
  });

  try {
    const blob = await Promise.race([
      doExport(xml, opts),
      overallDeadline,
    ]);
    log(`png-embed: export ok (durationMs=${Math.round(performance.now() - jobStart)}, size=${blob.size}B)`);
    return blob;
  } catch (e) {
    disposeEditorFrame();
    log(`png-embed: export failed (durationMs=${Math.round(performance.now() - jobStart)}): ${String(e)}`);
    throw e;
  } finally {
    if (overallTimer !== undefined) {
      window.clearTimeout(overallTimer);
    }
  }
}

async function doExport(xml: string, opts: EmbedExportOpts): Promise<Blob> {
  // inline-images (same-origin fetch + XML rewrite) and editor-frame
  // startup are independent; run them concurrently so the iframe
  // handshake overlaps with the image fetches. On inline failure fall
  // through with the original xml — external images will just stay
  // missing, which is the pre-fix behavior.
  const inlinedXml = inlineSameOriginImagesInXml(xml).catch((e) => {
    log('png-embed: inline-images threw, continuing with original xml:', e);
    return xml;
  });
  const [preparedXml, handle] = await Promise.all([inlinedXml, getEditorFrame()]);

  const protocolOpts: ExportOpts = {
    scale: opts.scale,
    bg: opts.bg,
    format: 'png',
  };
  const dataUrl = await requestExport(
    handle.window,
    handle.origin,
    preparedXml,
    protocolOpts,
    PROTOCOL_TIMEOUTS,
  );
  const rawBlob = await dataUrlToBlob(dataUrl);
  // drawio's bg param is unreliable (observed: atlas-type v6.8.9 returns
  // a transparent PNG despite bg="#ffffff"). Composite onto the requested
  // bg color in the parent window so the downloaded PNG is guaranteed
  // opaque over that color.
  return await flattenOntoBackground(rawBlob, opts.bg);
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function flattenOntoBackground(blob: Blob, bgColor: string): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      log('png-embed: flatten failed, no 2d context — returning original blob');
      return blob;
    }
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    const flattened = await canvasToBlob(canvas);
    if (flattened == null) {
      log('png-embed: flatten toBlob returned null — returning original blob');
      return blob;
    }
    log(`png-embed: flattened onto ${bgColor} (${blob.size}B → ${flattened.size}B)`);
    return flattened;
  } catch (e) {
    log('png-embed: flatten threw, returning original blob:', e);
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = (): void => resolve(img);
    img.onerror = (e): void => reject(e);
    img.src = src;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
}

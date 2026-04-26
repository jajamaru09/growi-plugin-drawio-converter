// src/exporter/mxgraph.ts
import type { ExportOptions, Viewer } from '../types';
import { log } from '../logger';

const OFFSCREEN_CSS =
  'position:fixed;left:-9999px;top:-9999px;width:1200px;height:900px;visibility:hidden;pointer-events:none;';

/**
 * Off-screen div を作り、data-mxgraph 属性を使って fresh な GraphViewer を構築し、
 * viewer.graph.getSvg(...) で SVG を取得する。
 *
 * @param mxgraphDataAttr — `.mxgraph` の data-mxgraph 属性値（JSON string）
 * @param opts
 * @returns 取得した SVGSVGElement。失敗時は null。
 */
export function renderToSvg(
  mxgraphDataAttr: string,
  opts: ExportOptions,
): Promise<SVGSVGElement | null> {
  return new Promise((resolve) => {
    const gv = window.GraphViewer;
    if (!gv) {
      log('renderToSvg: GraphViewer is not loaded');
      resolve(null);
      return;
    }

    const div = document.createElement('div');
    div.className = 'mxgraph';
    div.setAttribute('data-mxgraph', mxgraphDataAttr);
    div.style.cssText = OFFSCREEN_CSS;
    document.body.appendChild(div);

    let settled = false;
    const cleanup = (): void => {
      if (div.parentNode) div.parentNode.removeChild(div);
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      log('renderToSvg: timed out waiting for viewer callback (15s)');
      cleanup();
      resolve(null);
    }, 15000);

    try {
      gv.createViewerForElement(div, (viewer: Viewer) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);

        try {
          const graph = viewer?.graph;
          if (!graph || typeof graph.getSvg !== 'function') {
            log('renderToSvg: viewer.graph.getSvg is not a function');
            resolve(null);
            return;
          }

          // signature: background, scale, border, nocrop, crisp, ignoreSelection,
          // showText, imgExport, linkTarget, hasShadow, incExtFonts, keepTheme
          const incExtFonts = opts.incExtFonts ?? true;
          const svg = graph.getSvg(
            null,            // background (transparent, caller handles for PNG)
            1,               // scale
            0,               // border
            false,           // nocrop
            null,            // crisp
            true,            // ignoreSelection
            true,            // showText
            null,            // imgExport
            null,            // linkTarget
            false,           // hasShadow
            incExtFonts,     // external fonts: true for SVG, false for PNG (canvas taint)
            opts.isDarkMode, // keepTheme
          );
          resolve(svg);
        } catch (e) {
          log('renderToSvg: getSvg threw:', e);
          resolve(null);
        } finally {
          cleanup();
        }
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        log('renderToSvg: createViewerForElement threw:', e);
        cleanup();
        resolve(null);
      }
    }
  });
}

export function serializeSvg(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/**
 * SVG 要素からピクセル幅・高さを読み取る。
 * viewBox があればそれ、無ければ width/height 属性、最終手段 getBoundingClientRect。
 */
export function getSvgDimensions(svg: SVGSVGElement): { width: number; height: number } {
  const viewBox = svg.viewBox.baseVal;
  if (viewBox && (viewBox.width > 0 || viewBox.height > 0)) {
    return { width: viewBox.width, height: viewBox.height };
  }
  const w = parseFloat(svg.getAttribute('width') ?? '');
  const h = parseFloat(svg.getAttribute('height') ?? '');
  if (w > 0 && h > 0) return { width: w, height: h };
  const rect = svg.getBoundingClientRect();
  return { width: rect.width || 800, height: rect.height || 600 };
}

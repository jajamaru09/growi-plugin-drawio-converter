// src/dom/diagram-meta.ts
import type { DiagramMeta, GrowiPluginHub } from '../types';
import { log } from '../logger';

export const WRAPPER_SELECTOR = '[class*="drawio-viewer-with-edit-button"]';
export const INJECTED_ATTR = 'data-drawio-converter-injected';

function isReadyHub(h: unknown): h is GrowiPluginHub {
  return (
    typeof h === 'object' &&
    h !== null &&
    'api' in h &&
    typeof (h as GrowiPluginHub).api?.fetchPageInfo === 'function'
  );
}

export function findAllWrappers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(WRAPPER_SELECTOR));
}

/**
 * `.mxgraph[data-mxgraph]` から JSON をパースし、mxfile XML を返す。
 * 失敗時は null。
 */
export function extractXmlFromWrapper(wrapper: HTMLElement): { attr: string; xml: string } | null {
  const mxgraphDiv = wrapper.querySelector<HTMLElement>('.mxgraph');
  if (!mxgraphDiv) return null;

  const attr = mxgraphDiv.getAttribute('data-mxgraph');
  if (!attr) return null;

  try {
    const parsed = JSON.parse(attr) as { xml?: string };
    if (typeof parsed.xml !== 'string' || parsed.xml.length === 0) return null;
    return { attr, xml: parsed.xml };
  } catch (e) {
    log('data-mxgraph parse failed:', e);
    return null;
  }
}

/**
 * 与えられた wrapper のページ内でのインデックス（1-indexed）。
 * 同じページに複数 drawio ブロックがある場合の識別子に使う。
 */
export function getBlockIndex(wrapper: HTMLElement, allWrappers: HTMLElement[]): number {
  const idx = allWrappers.indexOf(wrapper);
  return idx < 0 ? 0 : idx + 1;
}

/**
 * ctx.revisionId が undefined の場合、hub API で現在ページの revision._id を取得する。
 * 取れなければ null。
 */
export async function resolveRevisionId(
  ctxPageId: string,
  ctxRevisionId: string | undefined,
): Promise<string | null> {
  if (ctxRevisionId) return ctxRevisionId;

  const hub = window.growiPluginHub;
  if (!isReadyHub(hub)) return null;

  try {
    const info = await hub.api.fetchPageInfo(ctxPageId);
    return info?.revision?._id ?? null;
  } catch (e) {
    log('fetchPageInfo failed:', e);
    return null;
  }
}

export function sanitizePageId(pageId: string): string {
  return pageId.replace(/^\//, '');
}

export function buildFilename(
  pageId: string,
  revisionId: string,
  blockIndex: number,
  ext: 'svg' | 'png',
): string {
  return `drawio-${pageId}-${revisionId}-${blockIndex}.${ext}`;
}

export function buildMeta(
  wrapper: HTMLElement,
  blockIndex: number,
  pageId: string,
  revisionId: string,
): DiagramMeta | null {
  const extracted = extractXmlFromWrapper(wrapper);
  if (!extracted) return null;

  return {
    wrapperEl: wrapper,
    mxgraphDataAttr: extracted.attr,
    xml: extracted.xml,
    pageId,
    revisionId,
    blockIndex,
  };
}

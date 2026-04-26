// src/exporter/png-embed/editor-frame.ts
// Hidden drawio Editor iframe lifecycle, scoped to a single GROWI page.
// Created lazily on the first PNG click, reused across subsequent clicks
// on the same page, disposed on onPageChange.
import { log } from '../../logger';
import { waitForInit } from './embed-protocol';

const VIEWER_SCRIPT_SELECTOR = 'script[src*="viewer-static.min.js"]';
const VIEWER_PATH_SUFFIX_REGEX = /\/js\/viewer-static\.min\.js(?:\?.*)?$/;
// `configure=1` makes drawio fire {event:'configure'} before {event:'init'}
// and wait for {action:'configure', config: DRAWIO_EMBED_CONFIG}.
const EMBED_QUERY = '?embed=1&proto=json&spin=0&ui=min&noSaveBtn=1&noExitBtn=1&configure=1';

// Disable drawio's auto-fit-on-load. Added in v29.6.2 (#5415); calling
// initialFitDiagram() between setFileData() and our subsequent {action:'export'}
// corrupts state for floating-point edges (no source/target cell) and for
// edgeLabels with empty geometry — they vanish from the exported PNG/SVG.
// We don't render the iframe, so the auto-fit had no benefit for us either way.
const DRAWIO_EMBED_CONFIG = {
  fitDiagramOnLoad: false,
  fitDiagramOnPage: false,
};

// Per spec: F3 handshake timeout 5s, F2 iframe load 8s.
// Wall-clock cap enforced by the caller (export-queue).
const IFRAME_LOAD_TIMEOUT_MS = 8000;
const INIT_TIMEOUT_MS = 5000;

export interface EditorFrameHandle {
  window: Window;
  origin: string;
}

let frameInstance: HTMLIFrameElement | null = null;
let readyPromise: Promise<EditorFrameHandle> | null = null;
let initRetriedOnce = false;

export function resolveEditorBaseUrl(): string | null {
  const script = document.querySelector<HTMLScriptElement>(VIEWER_SCRIPT_SELECTOR);
  if (!script || !script.src) return null;
  let url: URL;
  try {
    url = new URL(script.src);
  } catch {
    return null;
  }
  if (!VIEWER_PATH_SUFFIX_REGEX.test(url.pathname)) return null;
  const pathPrefix = url.pathname.replace(VIEWER_PATH_SUFFIX_REGEX, '/');
  return `${url.origin}${pathPrefix}`;
}

export function getEditorFrame(): Promise<EditorFrameHandle> {
  if (readyPromise) return readyPromise;
  readyPromise = createFrame();
  return readyPromise;
}

export function disposeEditorFrame(): void {
  if (frameInstance && frameInstance.parentNode) {
    frameInstance.parentNode.removeChild(frameInstance);
    log('editor-frame: disposed');
  }
  frameInstance = null;
  readyPromise = null;
  initRetriedOnce = false;
}

async function createFrame(): Promise<EditorFrameHandle> {
  const base = resolveEditorBaseUrl();
  if (!base) {
    throw new Error('editor-frame: could not resolve drawio editor base URL (viewer-static.min.js script tag not found)');
  }
  const src = `${base}${EMBED_QUERY}`;
  const origin = new URL(src).origin;

  try {
    return await createAndWaitForInit(src, origin);
  } catch (e) {
    // Spec: handshake failure only — retry once to survive tab-suspend /
    // SPA navigation edge cases. createAndWaitForInit has already cleaned
    // up the DOM at this point, so we just create a fresh one.
    if (!initRetriedOnce && /init timeout/i.test(String(e))) {
      initRetriedOnce = true;
      log('editor-frame: init timeout, retrying once');
      return await createAndWaitForInit(src, origin);
    }
    throw e;
  }
}

async function createAndWaitForInit(src: string, origin: string): Promise<EditorFrameHandle> {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'display:none;width:0;height:0;border:0;position:absolute;left:-9999px;top:-9999px;';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('tabindex', '-1');
  iframe.src = src;

  frameInstance = iframe;

  try {
    const loadDone = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(`editor-frame: iframe load timeout after ${IFRAME_LOAD_TIMEOUT_MS}ms (src=${src})`));
      }, IFRAME_LOAD_TIMEOUT_MS);
      iframe.addEventListener('load', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
      iframe.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error(`editor-frame: iframe error (src=${src})`));
      }, { once: true });
    });

    document.body.appendChild(iframe);
    log(`editor-frame: created iframe, src=${src}`);

    await loadDone;
    const w = iframe.contentWindow;
    if (!w) throw new Error('editor-frame: iframe.contentWindow is null after load');

    await waitForInit(w, origin, INIT_TIMEOUT_MS, DRAWIO_EMBED_CONFIG);
    log(`editor-frame: handshake complete (origin=${origin})`);
    return { window: w, origin };
  } catch (e) {
    // Ensure DOM cleanup on any failure so we don't leak hidden iframes.
    if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    if (frameInstance === iframe) frameInstance = null;
    throw e;
  }
}

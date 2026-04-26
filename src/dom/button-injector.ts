// src/dom/button-injector.ts
import type { DiagramMeta, GrowiPageContext, ProbeResult } from '../types';
import { log } from '../logger';
import {
  WRAPPER_SELECTOR,
  INJECTED_ATTR,
  findAllWrappers,
  buildMeta,
  buildFilename,
  resolveRevisionId,
  sanitizePageId,
  getBlockIndex,
} from './diagram-meta';
import {
  renderToSvg,
  serializeSvg,
  getSvgDimensions,
} from '../exporter/mxgraph';
import { exportPngLegacy } from '../exporter/png-legacy';
import { shouldUseLegacyPng } from '../exporter/export-mode';
import { exportPngViaEmbed, disposeEditorFrame } from '../exporter/png-embed';
import { inlineSameOriginImagesInSvg } from '../exporter/svg-inline-images';
import { downloadBlob } from '../exporter/download';
import { getPngScale, setPngScale, VALID_SCALES, type PngScale } from './png-scale';

// ========== Phase 1 findings ==========
// observer is unnecessary (verified on real GROWI: buttons persist across
// re-renders, modal open/close, SPA navigation). 4-step retry is enough.
const ENABLE_OBSERVER = false;

function isDarkMode(): boolean {
  return document.documentElement.getAttribute('data-bs-theme') === 'dark';
}

const DARK_BG = '#1a1a1a';
const LIGHT_BG = '#ffffff';
function backgroundColor(): string {
  return isDarkMode() ? DARK_BG : LIGHT_BG;
}
// =====================================================

const RETRY_DELAYS_MS = [200, 500, 1000, 2000];
const CONVERTER_BTN_ATTR = 'data-drawio-converter-btn';
const ACTIVE_WRAPPER_ATTR = 'data-drawio-converter-active';
const PNG_LABEL_ATTR = 'data-drawio-converter-png-label';
const BUTTON_CLASS = 'btn btn-sm btn-outline-secondary';

let probeResult: ProbeResult = 'unknown';
let observer: MutationObserver | null = null;
let lastCtx: GrowiPageContext | null = null;
let activeDropdown: { menu: HTMLElement; wrapper: HTMLElement } | null = null;
let outsideClickListenerAttached = false;

// ========== Hover-only visibility styles ==========

const STYLE_ELEMENT_ID = 'drawio-converter-styles';
const STYLE_CONTENT = `
[class*="drawio-viewer-with-edit-button"] [${CONVERTER_BTN_ATTR}] {
  opacity: 0;
  transition: opacity 0.15s ease;
  pointer-events: none;
}
[class*="drawio-viewer-with-edit-button"]:hover [${CONVERTER_BTN_ATTR}],
[class*="drawio-viewer-with-edit-button"] [${CONVERTER_BTN_ATTR}]:disabled,
[class*="drawio-viewer-with-edit-button"][${ACTIVE_WRAPPER_ATTR}] [${CONVERTER_BTN_ATTR}] {
  opacity: 1;
  pointer-events: auto;
}
[${CONVERTER_BTN_ATTR}="png-menu"] {
  display: none;
  position: absolute;
  z-index: 1050;
  min-width: 6rem;
  margin: 0;
  padding: 0.25rem 0;
  list-style: none;
  background: var(--bs-body-bg, #fff);
  color: var(--bs-body-color, inherit);
  border: 1px solid var(--bs-border-color, rgba(0, 0, 0, 0.175));
  border-radius: 0.375rem;
  box-shadow: 0 0.5rem 1rem rgba(0, 0, 0, 0.175);
}
[${CONVERTER_BTN_ATTR}="png-menu"].show {
  display: block;
}
[${CONVERTER_BTN_ATTR}="png-menu"] button {
  display: block;
  width: 100%;
  padding: 0.25rem 1rem;
  text-align: left;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
}
[${CONVERTER_BTN_ATTR}="png-menu"] button:hover {
  background: var(--bs-secondary-bg, rgba(0, 0, 0, 0.075));
}
[${CONVERTER_BTN_ATTR}="png-menu"] button[aria-checked="true"] {
  font-weight: 600;
}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLE_CONTENT;
  document.head.appendChild(style);
}

function removeStyles(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
}

// ========== Inline error display ==========

const ERROR_MSG_ATTR = 'data-drawio-converter-error';
const ERROR_AUTO_HIDE_MS = 5000;

function showInlineError(anchor: HTMLElement, text: string): void {
  const wrapper = anchor.closest<HTMLElement>(WRAPPER_SELECTOR);
  if (!wrapper) return;

  // Remove any existing error for this wrapper
  wrapper.querySelectorAll(`[${ERROR_MSG_ATTR}]`).forEach((el) => el.remove());

  const msg = document.createElement('div');
  msg.setAttribute(ERROR_MSG_ATTR, 'true');
  msg.textContent = text;
  msg.style.cssText =
    'color:var(--bs-danger, #dc3545);font-size:0.8rem;margin-top:4px;padding:4px 8px;' +
    'background:var(--bs-body-bg, #fff);border:1px solid var(--bs-danger, #dc3545);' +
    'border-radius:0.25rem;display:block;max-width:400px;';

  // Insert after the btn-group that contains the clicked button so we don't
  // break the flex layout inside the btn-group. Fall back to inserting after
  // the anchor itself (e.g. SVG button) if the anchor isn't inside a group.
  const group = anchor.closest<HTMLElement>('.btn-group');
  const insertAfter = group ?? anchor;
  insertAfter.insertAdjacentElement('afterend', msg);

  window.setTimeout(() => {
    msg.remove();
  }, ERROR_AUTO_HIDE_MS);
}

// ========== Probe ==========

function runProbe(): Promise<void> {
  return new Promise((resolve) => {
    const gv = window.GraphViewer;
    if (!gv) {
      log('probe: GraphViewer not loaded, will retry on next onPageChange');
      resolve();
      return;
    }

    const div = document.createElement('div');
    div.className = 'mxgraph';
    const mxdata = {
      xml: '<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>',
      editable: false,
    };
    div.setAttribute('data-mxgraph', JSON.stringify(mxdata));
    div.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:100px;height:100px;visibility:hidden;';
    document.body.appendChild(div);

    let settled = false;
    const cleanup = (): void => {
      if (div.parentNode) div.parentNode.removeChild(div);
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      probeResult = 'unavailable';
      log('probe: timed out, marking unavailable');
      cleanup();
      resolve();
    }, 5000);

    try {
      gv.createViewerForElement(div, (viewer) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        const ok = typeof viewer?.graph?.getSvg === 'function';
        probeResult = ok ? 'available' : 'unavailable';
        log('probe: getSvg available=', ok, '(cached)');
        cleanup();
        resolve();
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        probeResult = 'unavailable';
        log('probe: createViewerForElement threw:', e);
        cleanup();
        resolve();
      }
    }
  });
}

// ========== Dropdown state ==========

function closeActiveDropdown(): void {
  if (!activeDropdown) return;
  activeDropdown.menu.classList.remove('show');
  activeDropdown.wrapper.removeAttribute(ACTIVE_WRAPPER_ATTR);
  activeDropdown = null;
}

function openDropdown(menu: HTMLElement, wrapper: HTMLElement): void {
  if (activeDropdown && activeDropdown.menu !== menu) closeActiveDropdown();
  menu.classList.add('show');
  wrapper.setAttribute(ACTIVE_WRAPPER_ATTR, 'true');
  activeDropdown = { menu, wrapper };
}

function ensureOutsideClickListener(): void {
  if (outsideClickListenerAttached) return;
  outsideClickListenerAttached = true;
  document.addEventListener('click', (e) => {
    if (!activeDropdown) return;
    if (activeDropdown.menu.contains(e.target as Node)) return;
    closeActiveDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeActiveDropdown();
  });
}

function updateAllPngLabels(): void {
  const scale = getPngScale();
  document
    .querySelectorAll<HTMLElement>(`[${PNG_LABEL_ATTR}]`)
    .forEach((el) => {
      el.textContent = `PNG ${scale}x`;
    });
  document
    .querySelectorAll<HTMLElement>(`[${CONVERTER_BTN_ATTR}="png-menu"] button[data-scale]`)
    .forEach((btn) => {
      btn.setAttribute(
        'aria-checked',
        btn.dataset.scale === String(scale) ? 'true' : 'false',
      );
    });
}

// ========== Button creation ==========

function setGenerating(btn: HTMLButtonElement, generating: boolean, restoreHtml: string): void {
  if (generating) {
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined me-1">hourglass_empty</span>Generating…`;
  } else {
    btn.disabled = false;
    btn.innerHTML = restoreHtml;
  }
}

function createSvgButton(meta: DiagramMeta): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BUTTON_CLASS;
  btn.setAttribute(CONVERTER_BTN_ATTR, 'svg');
  btn.style.marginLeft = '4px';
  btn.innerHTML = `<span class="material-symbols-outlined me-1">download</span>SVG`;

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (btn.disabled) return;
    const originalHtml = btn.innerHTML;
    setGenerating(btn, true, originalHtml);
    try {
      await exportSvg(meta);
    } catch (err) {
      log('export[svg] failed:', err);
    } finally {
      setGenerating(btn, false, originalHtml);
    }
  });

  return btn;
}

function createPngGroup(meta: DiagramMeta): HTMLElement {
  const scale = getPngScale();

  const group = document.createElement('div');
  group.className = 'btn-group';
  group.setAttribute(CONVERTER_BTN_ATTR, 'png-group');
  group.style.marginLeft = '4px';
  group.style.position = 'relative';

  // Main button: click downloads at current scale
  const mainBtn = document.createElement('button');
  mainBtn.type = 'button';
  mainBtn.className = BUTTON_CLASS;
  mainBtn.setAttribute(CONVERTER_BTN_ATTR, 'png');
  mainBtn.innerHTML =
    `<span class="material-symbols-outlined me-1">download</span>` +
    `<span ${PNG_LABEL_ATTR}>PNG ${scale}x</span>`;

  mainBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (mainBtn.disabled) return;
    closeActiveDropdown();
    const originalHtml = mainBtn.innerHTML;
    setGenerating(mainBtn, true, originalHtml);
    try {
      await exportPng(meta, mainBtn);
    } finally {
      setGenerating(mainBtn, false, originalHtml);
    }
  });

  // Caret button: opens dropdown
  const caretBtn = document.createElement('button');
  caretBtn.type = 'button';
  caretBtn.className = `${BUTTON_CLASS} dropdown-toggle dropdown-toggle-split`;
  caretBtn.setAttribute(CONVERTER_BTN_ATTR, 'png-caret');
  caretBtn.setAttribute('aria-expanded', 'false');
  caretBtn.setAttribute('aria-label', 'Change PNG scale');
  caretBtn.innerHTML = `<span class="visually-hidden">Toggle scale dropdown</span>`;

  // Dropdown menu (sibling of buttons inside the btn-group so it positions below)
  const menu = document.createElement('ul');
  menu.setAttribute(CONVERTER_BTN_ATTR, 'png-menu');
  menu.style.top = '100%';
  menu.style.left = '0';

  VALID_SCALES.forEach((s) => {
    const li = document.createElement('li');
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.scale = String(s);
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', s === scale ? 'true' : 'false');
    item.textContent = `${s}x`;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      setPngScale(s as PngScale);
      updateAllPngLabels();
      closeActiveDropdown();
      log(`png-scale: set to ${s}x`);
    });
    li.appendChild(item);
    menu.appendChild(li);
  });

  caretBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const wrapper = group.closest<HTMLElement>(WRAPPER_SELECTOR);
    if (!wrapper) return;
    const isOpen = activeDropdown?.menu === menu;
    if (isOpen) {
      closeActiveDropdown();
      caretBtn.setAttribute('aria-expanded', 'false');
    } else {
      openDropdown(menu, wrapper);
      caretBtn.setAttribute('aria-expanded', 'true');
    }
  });

  group.appendChild(mainBtn);
  group.appendChild(caretBtn);
  group.appendChild(menu);

  return group;
}

async function exportSvg(meta: DiagramMeta): Promise<void> {
  const start = performance.now();
  const svg = await renderToSvg(meta.mxgraphDataAttr, { isDarkMode: isDarkMode() });
  if (!svg) {
    log(`export[svg]: failed for wrapper#${meta.blockIndex}`);
    return;
  }
  const rawSvgString = serializeSvg(svg);
  // Inline same-origin attachment image references so the downloaded
  // SVG stays self-contained when opened outside the GROWI session.
  const { svg: svgString, inlined, skipped } = await inlineSameOriginImagesInSvg(rawSvgString);
  if (inlined.length > 0) {
    log(`export[svg]: inlined ${inlined.length} same-origin image(s):`, inlined);
  }
  if (skipped.length > 0) {
    log(`export[svg]: skipped ${skipped.length} image(s) (external or failed):`, skipped);
  }
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const filename = buildFilename(meta.pageId, meta.revisionId, meta.blockIndex, 'svg');
  downloadBlob(blob, filename);
  log(`export[svg]: wrapper#${meta.blockIndex} filename=${filename} size=${blob.size}B took ${Math.round(performance.now() - start)}ms`);
}

async function exportPng(meta: DiagramMeta, anchorBtn: HTMLElement): Promise<void> {
  const start = performance.now();
  const scale = getPngScale();
  const legacy = shouldUseLegacyPng();
  const mode = legacy ? 'legacy' : 'embed';

  let blob: Blob | null = null;
  let stage: 'start' | 'render' | 'convert' | 'embed' | 'done' = 'start';

  try {
    if (legacy) {
      stage = 'render';
      const svg = await renderToSvg(meta.mxgraphDataAttr, {
        isDarkMode: isDarkMode(),
        incExtFonts: false,
      });
      if (!svg) throw new Error('legacy: svg render returned null');
      const { width, height } = getSvgDimensions(svg);
      const svgString = serializeSvg(svg);
      stage = 'convert';
      blob = await exportPngLegacy(svgString, {
        isDarkMode: isDarkMode(),
        width,
        height,
        scale,
      });
      if (!blob) throw new Error('legacy: png convert returned null');
    } else {
      stage = 'embed';
      blob = await exportPngViaEmbed(meta.xml, {
        scale,
        bg: backgroundColor(),
      });
    }
    stage = 'done';
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    log(`png export failed: mode=${mode}, stage=${stage}, scale=${scale}, durationMs=${durationMs}, wrapper#${meta.blockIndex}, error=`, err);
    showInlineError(anchorBtn, 'PNG の生成に失敗しました。しばらく待って再度お試しください。詳細はブラウザのコンソールログをご確認ください。');
    return;
  }

  const durationMs = Math.round(performance.now() - start);
  const filename = buildFilename(meta.pageId, meta.revisionId, meta.blockIndex, 'png');
  downloadBlob(blob, filename);
  log(`png export: mode=${mode}, scale=${scale}, durationMs=${durationMs}, size=${blob.size}B, filename=${filename}, wrapper#${meta.blockIndex}`);
}

function inject(wrapper: HTMLElement, meta: DiagramMeta): void {
  if (wrapper.getAttribute(INJECTED_ATTR) === 'true') {
    log(`inject: wrapper#${meta.blockIndex} skipped (already injected)`);
    return;
  }
  wrapper.setAttribute(INJECTED_ATTR, 'true');

  const svgBtn = createSvgButton(meta);
  const pngGroup = createPngGroup(meta);

  const editBtn = wrapper.querySelector('.btn-edit-drawio');
  if (editBtn) {
    editBtn.after(svgBtn);
    svgBtn.after(pngGroup);
  } else {
    wrapper.prepend(pngGroup);
    wrapper.prepend(svgBtn);
  }

  log(`inject: wrapper#${meta.blockIndex} pageId=${meta.pageId} rev=${meta.revisionId}`);
}

// ========== Scan ==========

async function scan(ctx: GrowiPageContext): Promise<void> {
  if (ctx.mode !== 'view') return;

  if (probeResult === 'unknown') {
    await runProbe();
  }
  if (probeResult !== 'available') return;

  const wrappers = findAllWrappers();
  if (wrappers.length === 0) return;

  const pageId = sanitizePageId(ctx.pageId);
  const revisionId = await resolveRevisionId(pageId, ctx.revisionId);
  if (!revisionId) {
    log('scan: could not resolve revisionId, skipping');
    return;
  }

  log(`scan: found ${wrappers.length} wrapper(s)`);

  wrappers.forEach((wrapper) => {
    if (wrapper.getAttribute(INJECTED_ATTR) === 'true') return;
    const blockIndex = getBlockIndex(wrapper, wrappers);
    const meta = buildMeta(wrapper, blockIndex, pageId, revisionId);
    if (!meta) {
      log(`scan: wrapper#${blockIndex} has no valid meta, skipping`);
      return;
    }
    inject(wrapper, meta);
  });
}

function scanWithRetries(ctx: GrowiPageContext): void {
  RETRY_DELAYS_MS.forEach((delay) => {
    window.setTimeout(() => {
      void scan(ctx);
    }, delay);
  });
}

// ========== MutationObserver ==========

function startObserver(): void {
  if (!ENABLE_OBSERVER) return;
  if (observer) return;

  let pending = false;
  observer = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      if (lastCtx) void scan(lastCtx);
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ========== Public API ==========

export function onPageChange(ctx: GrowiPageContext): void {
  log('page changed:', ctx);
  disposeEditorFrame();
  lastCtx = ctx;
  ensureStyles();
  ensureOutsideClickListener();
  void scan(ctx);
  scanWithRetries(ctx);
  startObserver();
}

export function removeAllButtons(): void {
  closeActiveDropdown();
  const btns = document.querySelectorAll<HTMLElement>(`[${CONVERTER_BTN_ATTR}]`);
  btns.forEach((b) => b.remove());
  const wrappers = document.querySelectorAll<HTMLElement>(WRAPPER_SELECTOR);
  wrappers.forEach((w) => {
    w.removeAttribute(INJECTED_ATTR);
    w.removeAttribute(ACTIVE_WRAPPER_ATTR);
  });
  log(`cleanup: removed ${btns.length} converter elements`);
}

export function cleanup(): void {
  stopObserver();
  removeAllButtons();
  removeStyles();
  disposeEditorFrame();
  lastCtx = null;
}

// src/exporter/png.ts
import { log } from '../../logger';
import { inlineSameOriginImagesInSvg } from '../svg-inline-images';

const DEFAULT_SCALE = 2;
const DARK_BG = '#1a1a1a';
const LIGHT_BG = '#ffffff';

export interface PngOptions {
  scale?: number;          // default 2
  isDarkMode: boolean;
  width: number;
  height: number;
}

interface SanitizeResult {
  sanitized: string;
  externalRefs: string[];
  stats: { image: number; use: number; foreignObject: number; urlHttp: number };
}

interface ConvertedLine {
  text: string;
  svgX: number;
  svgY: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  weight: string;
  italic: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Convert each `<foreignObject>` label to an equivalent `<text>`/`<tspan>`
 * structure by temporarily mounting the SVG in the live DOM and measuring the
 * rendered line boxes of the embedded HTML with the Range API.
 *
 * Why: drawio emits rich-text labels as HTML inside `<foreignObject>`, which
 * relies on CSS word-wrap. Simply stripping the `<foreignObject>` leaves a
 * single-line `<text>` fallback that overflows the shape. Toggling
 * `mxSvgCanvas2D.foEnabled = false` on the viewer only produces unwrapped
 * `<text>` (the bundled viewer does not emit `<tspan>` wrapping). Measuring
 * the already-wrapped HTML via the browser's layout engine and projecting the
 * measured coordinates back into SVG user space via `getScreenCTM().inverse()`
 * gives us wrapped output that matches the on-screen rendering.
 */
async function convertForeignObjectsToText(svgString: string): Promise<{
  result: string;
  converted: number;
  total: number;
}> {
  const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  if (parsed.querySelector('parsererror') != null) {
    log('convertForeignObjects: DOMParser failed, returning original');
    return { result: svgString, converted: 0, total: 0 };
  }

  const importedSvg = document.importNode(parsed.documentElement, true) as unknown as SVGSVGElement;
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-9999px;top:-9999px;pointer-events:none;visibility:hidden;';
  host.appendChild(importedSvg);
  document.body.appendChild(host);

  try {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    const ctm = importedSvg.getScreenCTM();
    if (ctm == null) {
      log('convertForeignObjects: getScreenCTM returned null, returning original');
      return { result: svgString, converted: 0, total: 0 };
    }
    const ctmInv = ctm.inverse();

    const fos = Array.from(importedSvg.querySelectorAll('foreignObject'));
    let converted = 0;

    for (const fo of fos) {
      const parent = fo.parentElement;
      const removeTarget: Element = parent?.localName === 'switch' ? parent : fo;
      const inner = fo.querySelector('div');
      if (inner == null) {
        removeTarget.remove();
        continue;
      }

      // Ancestor rotations make each char's viewport AABB a rotated quad's
      // bounding box; per-char rect.top then varies between characters on the
      // same logical line, producing one tspan per character. Strip rotate()
      // from ancestor transforms so the HTML lays out axis-aligned for
      // measurement, then restore. The <text> we insert inherits the restored
      // rotation and ends up at the original visual position.
      const rotBackups = stripAncestorRotations(removeTarget, importedSvg);
      if (rotBackups.length > 0) {
        void (host as HTMLElement).offsetHeight;
      }

      const lines = extractWrappedLines(inner, ctmInv);

      restoreAncestorRotations(rotBackups);

      if (lines.length === 0) {
        removeTarget.remove();
        continue;
      }

      const textEl = buildTextElement(lines);
      removeTarget.replaceWith(textEl);
      converted++;
    }

    return {
      result: new XMLSerializer().serializeToString(importedSvg),
      converted,
      total: fos.length,
    };
  } finally {
    host.remove();
  }
}

/**
 * Walk text nodes inside a foreignObject's HTML subtree, splitting each text
 * node into wrapped lines by sampling per-character client rects and detecting
 * line breaks from changes in `rect.top`.
 */
function extractWrappedLines(inner: HTMLElement, ctmInv: DOMMatrix): ConvertedLine[] {
  const lines: ConvertedLine[] = [];
  const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT);
  let node: Node | null;

  while ((node = walker.nextNode()) != null) {
    const tn = node as Text;
    const text = tn.textContent ?? '';
    if (text.length === 0) continue;
    const parentEl = tn.parentElement;
    if (parentEl == null) continue;

    const st = getComputedStyle(parentEl);
    const fontSize = parseFloat(st.fontSize) || 12;
    const meta = {
      fontSize,
      fontFamily: st.fontFamily,
      color: st.color,
      weight: st.fontWeight,
      italic: st.fontStyle === 'italic',
    };

    // ::marker 疑似要素は TreeWalker(SHOW_TEXT) で拾えないので、
    // <li> 内の最初のテキストノードの先頭行にマーカーを明示的に prepend。
    const marker = getListMarkerIfFirstText(tn);

    let cur: ConvertedLine | null = null;
    let prevTop: number | null = null;
    let isFirstLine = true;

    for (let i = 0; i < text.length; i++) {
      const r = document.createRange();
      r.setStart(tn, i);
      r.setEnd(tn, i + 1);
      const rect = r.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        if (cur != null) cur.text += text[i];
        continue;
      }
      if (prevTop == null || Math.abs(rect.top - prevTop) > fontSize * 0.5) {
        // baseline ≈ bottom - 20% of line height (rough but consistent)
        const baseY = rect.bottom - rect.height * 0.2;
        const p = new DOMPoint(rect.left, baseY).matrixTransform(ctmInv);
        const prefix = isFirstLine && marker != null ? marker : '';
        cur = { text: prefix + text[i], svgX: p.x, svgY: p.y, ...meta };
        lines.push(cur);
        prevTop = rect.top;
        isFirstLine = false;
      } else {
        cur!.text += text[i];
      }
    }
  }

  return lines;
}

/**
 * Return the list marker string ("1. ", "• ", ...) if the given text node is
 * the first content-bearing text node inside an enclosing <li>. Otherwise null.
 */
function getListMarkerIfFirstText(node: Text): string | null {
  let el: Element | null = node.parentElement;
  while (el != null && el.localName !== 'li') {
    el = el.parentElement;
  }
  if (el == null) return null;
  const li = el;

  const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode()) != null) {
    if ((n.textContent ?? '').length > 0) {
      if (n !== node) return null;
      break;
    }
  }

  const list = li.parentElement;
  if (list == null) return null;
  const tag = list.localName;
  const items = Array.from(list.children).filter((c) => c.localName === 'li');
  const idx = items.indexOf(li);
  if (idx < 0) return null;
  if (tag === 'ol') return `${idx + 1}. `;
  if (tag === 'ul') return '• ';
  return null;
}

interface RotationBackup {
  element: Element;
  originalTransform: string | null;
}

/**
 * Strip any `rotate(...)` segment from ancestor transform attributes up to
 * `stopAt`. Returns backups so they can be restored after measurement.
 * Other transform segments (translate, scale, matrix) are preserved.
 */
function stripAncestorRotations(start: Element, stopAt: Element): RotationBackup[] {
  const backups: RotationBackup[] = [];
  let el: Element | null = start.parentElement;
  while (el != null && el !== stopAt) {
    const t = el.getAttribute('transform');
    if (t != null && /\brotate\s*\(/i.test(t)) {
      backups.push({ element: el, originalTransform: t });
      const stripped = t.replace(/\brotate\s*\([^)]*\)/gi, '').replace(/\s{2,}/g, ' ').trim();
      if (stripped.length > 0) {
        el.setAttribute('transform', stripped);
      } else {
        el.removeAttribute('transform');
      }
    }
    el = el.parentElement;
  }
  return backups;
}

function restoreAncestorRotations(backups: RotationBackup[]): void {
  for (const b of backups) {
    if (b.originalTransform != null) {
      b.element.setAttribute('transform', b.originalTransform);
    }
  }
}

function buildTextElement(lines: ConvertedLine[]): SVGTextElement {
  const textEl = document.createElementNS(SVG_NS, 'text');
  // Font attributes are applied per-tspan rather than on the parent <text>,
  // because rich-text foreignObjects mix sizes (e.g. <h1> at 24px and <p> at
  // 12px). If the parent <text> carries the first line's size, subsequent
  // tspans inherit it and render at the wrong glyph width, causing overlap.
  for (const L of lines) {
    const tspan = document.createElementNS(SVG_NS, 'tspan');
    tspan.setAttribute('x', String(L.svgX));
    tspan.setAttribute('y', String(L.svgY));
    tspan.setAttribute('fill', L.color);
    tspan.setAttribute('font-family', L.fontFamily);
    tspan.setAttribute('font-size', String(L.fontSize));
    const w = L.weight;
    if (parseInt(w, 10) >= 600 || w === 'bold' || w === 'bolder') {
      tspan.setAttribute('font-weight', 'bold');
    }
    if (L.italic) tspan.setAttribute('font-style', 'italic');
    tspan.textContent = L.text;
    textEl.appendChild(tspan);
  }
  return textEl;
}

/**
 * Remove references that taint the canvas during rasterization.
 *
 * `<foreignObject>` is normally converted to `<text>`/`<tspan>` by
 * `convertForeignObjectsToText` upstream. This function strips any that slip
 * through (parse errors, missing inner div) as a safety net, along with
 * external <image>, <use>, @font-face, and url(http…) references.
 * Same-origin <image> hrefs are assumed to have already been inlined as data
 * URIs by `inlineSameOriginImagesInSvg`.
 */
function sanitizeForCanvas(svgString: string): SanitizeResult {
  const externalRefs: string[] = [];
  let result = svgString;

  const stats = {
    image: (result.match(/<image\b/gi) ?? []).length,
    use: (result.match(/<use\b/gi) ?? []).length,
    foreignObject: (result.match(/<foreignObject\b/gi) ?? []).length,
    urlHttp: (result.match(/url\(\s*["']?https?:/gi) ?? []).length,
  };

  // 1. <foreignObject> — remove entirely (primary taint source even with no external URLs)
  result = result.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, () => {
    externalRefs.push('<foreignObject> (removed; HTML in SVG taints canvas)');
    return '';
  });

  // 2. <image> with remaining non-data href — blank the href so no fetch happens
  result = result.replace(/<image\b([^>]*)>/gi, (_match, attrs: string) => {
    const newAttrs = attrs.replace(
      /\s+(xlink:)?href\s*=\s*(["'])([^"']*)\2/gi,
      (full, xlink: string | undefined, quote: string, href: string) => {
        if (/^data:/i.test(href)) return full;
        externalRefs.push(`<image> ${href}`);
        return ` ${xlink ?? ''}href=${quote}${quote}`;
      },
    );
    return `<image${newAttrs}>`;
  });

  // 3. <use xlink:href="http…"> — remove element
  result = result.replace(
    /<use\b[^>]*?(?:xlink:)?href\s*=\s*["']https?:[^"']*["'][^>]*?\/?>/gi,
    (match) => {
      const m = match.match(/href\s*=\s*["']([^"']+)/i);
      externalRefs.push(`<use> ${m?.[1] ?? '(unknown)'}`);
      return '';
    },
  );

  // 4. @font-face { … url(http…) … } — drop rule
  result = result.replace(/@font-face\s*\{[^}]*url\(\s*["']?https?:[^}]*\}/gi, () => {
    externalRefs.push('@font-face with external url');
    return '';
  });

  // 5. Stray url(http…) in CSS — neutralize
  result = result.replace(/url\(\s*["']?(https?:[^)'"]*)\s*["']?\s*\)/gi, (_m, href: string) => {
    externalRefs.push(`url() ${href}`);
    return 'url("")';
  });

  return { sanitized: result, externalRefs, stats };
}

function rasterize(
  svgString: string,
  width: number,
  height: number,
  scale: number,
  bg: string,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const cleanup = (): void => URL.revokeObjectURL(url);
    const timeout = window.setTimeout(() => {
      log('svgToPng: image load timed out (15s)');
      cleanup();
      resolve(null);
    }, 15000);

    img.onload = (): void => {
      window.clearTimeout(timeout);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          log('svgToPng: failed to get 2d context');
          cleanup();
          resolve(null);
          return;
        }

        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob((blob) => {
          cleanup();
          if (!blob) {
            log('svgToPng: canvas.toBlob returned null');
            resolve(null);
            return;
          }
          resolve(blob);
        }, 'image/png');
      } catch (e) {
        log('svgToPng: drawImage / toBlob threw:', e);
        log('svgToPng: SVG head (500ch):', svgString.slice(0, 500));
        log('svgToPng: SVG tail (300ch):', svgString.slice(-300));
        cleanup();
        resolve(null);
      }
    };

    img.onerror = (e): void => {
      window.clearTimeout(timeout);
      log('svgToPng: image failed to load:', e);
      cleanup();
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * SVG string を PNG Blob に変換する。
 * 1) 同一オリジン画像 (<image href="/attachment/..." など) を data URI にインライン化
 * 2) <foreignObject> 内の HTML を DOM 測定して <text>/<tspan> に変換
 *    (HTML/CSS で折り返されているラベルを SVG で保持するため)
 * 3) canvas を汚染する残留要素 (外部 URL 参照など) を除去 (safety net)
 * 4) <img> 経由で Image に読み込んで canvas にラスタライズ
 */
export async function svgToPng(svgString: string, opts: PngOptions): Promise<Blob | null> {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const bg = opts.isDarkMode ? DARK_BG : LIGHT_BG;

  // Step 1: inline same-origin <image> hrefs and <img src> as data URIs
  const { svg: withInlined, inlined, skipped } = await inlineSameOriginImagesInSvg(svgString);
  if (inlined.length > 0) {
    log(`svgToPng: inlined ${inlined.length} same-origin image(s):`, inlined);
  }
  if (skipped.length > 0) {
    log(`svgToPng: skipped ${skipped.length} image(s) (external or failed):`, skipped);
  }

  // Step 2: convert <foreignObject> → <text>/<tspan> preserving wrap positions
  const { result: withSvgText, converted, total } = await convertForeignObjectsToText(withInlined);
  if (total > 0) {
    log(`svgToPng: converted ${converted}/${total} <foreignObject> to <text>/<tspan>`);
  }

  // Step 3: strip remaining taint sources (safety net)
  const { sanitized, externalRefs, stats } = sanitizeForCanvas(withSvgText);
  log(
    `svgToPng: pre-sanitize counts <image>=${stats.image} <use>=${stats.use} ` +
      `<foreignObject>=${stats.foreignObject} url(http…)=${stats.urlHttp}`,
  );
  if (externalRefs.length > 0) {
    log(`svgToPng: stripped ${externalRefs.length} reference(s):`, externalRefs);
  }

  // Step 4: rasterize
  return rasterize(sanitized, opts.width, opts.height, scale, bg);
}

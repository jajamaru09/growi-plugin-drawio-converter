// src/exporter/png-embed/inline-images.ts
// Pre-fetch same-origin image references in drawio XML and replace them
// with data URIs so drawio's native PNG export can include them.
//
// Why: drawio's embed-mode export resolves referenced images via
// `EditorUi.convertImages`, which walks both SVG `<image>` elements AND
// HTML `<img>` elements inside foreignObject-backed labels. For each it
// does an Image() load with cross-origin semantics, then falls back to
// the drawio container's `/proxy?url=...` endpoint. Both paths fail for
// GROWI attachments: the cross-origin Image load has no cookies and no
// CORS, and the proxy container can't reach the GROWI URL. A
// same-origin `fetch()` from the parent window (which has the session
// cookie) can retrieve the bytes reliably.
//
// How:
//   1. Cells with `style="...shape=image;image=<URL>..."` can't just
//      have their `image=` value swapped with a base64 data URI, because
//      drawio's style parser splits on `;` and truncates any value
//      containing `;base64,`. Non-base64 (`data:image/png,<pct-encoded>`)
//      survives the parser but then fails to load inside drawio iframe
//      (Chrome `<img crossOrigin='anonymous'>` + long pct-encoded data
//      URI silently fails to render). So we RESHAPE the cell into
//      `shape=label;html=1` whose label HTML is `<img src="<base64>">`.
//      HTML `<img>` with base64 is the most reliable path.
//   2. `<UserObject image="<URL>">` / `<object image="<URL>">`: attribute
//      value, not a style string, so base64 data URIs work directly.
//   3. `<mxCell value="&lt;img src=&quot;<URL>&quot;&gt;">`: HTML label
//      with <img src>. Regex-replace src values with base64 data URIs.
//
// Complication: drawio stores <diagram> contents deflate+base64-encoded
// by default (Graph.compress). We inflate any compressed <diagram>,
// process the cells, and inject the result back as an uncompressed
// <mxGraphModel> (drawio's loader accepts both forms).
import { log } from '../../logger';
import { isSameOrigin, fetchAsDataUri } from '../image-fetch';

interface StyleImageRef { el: Element; url: string; }
interface AttrRef { el: Element; url: string; }

const STYLE_IMAGE_REGEX = /(^|;)image=([^;]*)/;

function findImageInStyle(style: string): { rawValue: string; decoded: string } | null {
  const m = STYLE_IMAGE_REGEX.exec(style);
  if (!m) return null;
  const rawValue = m[2];
  try {
    return { rawValue, decoded: decodeURIComponent(rawValue) };
  } catch {
    return { rawValue, decoded: rawValue };
  }
}

function stripStyleKeys(style: string, keys: string[]): string {
  const toRemove = new Set(keys);
  const kept = style.split(';').filter((p) => {
    const eq = p.indexOf('=');
    if (eq < 0) return p.length > 0;
    return !toRemove.has(p.substring(0, eq));
  });
  return kept.join(';');
}

function xmlAttrEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Reshape a `shape=image;image=<URL>` cell into `shape=label;html=1`
// carrying the image as HTML `<img>` in the label. The label goes on
// the parent UserObject/object if present (drawio's UserObject `label`
// attribute overrides the wrapped mxCell's `value`), otherwise on the
// mxCell itself.
function reshapeImageCellToHtmlLabel(cell: Element, base64DataUri: string): void {
  const oldStyle = cell.getAttribute('style') ?? '';
  const stripped = stripStyleKeys(oldStyle, [
    'shape', 'image', 'aspect',
    'imageAspect', 'imageWidth', 'imageHeight',
    'verticalLabelPosition', 'labelBackgroundColor', 'labelPosition',
  ]);
  const newStyle =
    'shape=label;html=1;strokeColor=none;fillColor=none;' +
    'align=center;verticalAlign=middle;overflow=fill;' +
    'spacing=0;spacingTop=0;spacingBottom=0;spacingLeft=0;spacingRight=0;' +
    (stripped ? stripped + ';' : '');
  cell.setAttribute('style', newStyle);

  const imgHtml =
    `<img src="${xmlAttrEscape(base64DataUri)}" ` +
    `style="display:block;width:100%;height:100%;object-fit:contain;" alt=""/>`;

  const parent = cell.parentElement;
  if (parent && (parent.tagName === 'UserObject' || parent.tagName === 'object')) {
    parent.setAttribute('label', imgHtml);
  } else {
    cell.setAttribute('value', imgHtml);
  }
}

// `\s` before `src` prevents false matches inside attribute names like
// `data-src` or `srcset`.
const HTML_IMG_SRC_REGEX = /<img\b[^>]*?\ssrc\s*=\s*(["'])([^"']+)\1/gi;

function extractImgSrcsFromHtml(html: string): string[] {
  const urls: string[] = [];
  HTML_IMG_SRC_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_IMG_SRC_REGEX.exec(html)) != null) {
    urls.push(m[2]);
  }
  return urls;
}

function replaceImgSrcsInHtml(
  html: string,
  cache: Map<string, string | null>,
): { html: string; replaced: number } {
  let replaced = 0;
  const out = html.replace(HTML_IMG_SRC_REGEX, (full, quote: string, src: string) => {
    const dataUri = cache.get(src);
    if (!dataUri) return full;
    const suffix = `${quote}${src}${quote}`;
    if (!full.endsWith(suffix)) return full;
    replaced++;
    return full.slice(0, full.length - suffix.length) + `${quote}${dataUri}${quote}`;
  });
  return { html: out, replaced };
}

// Inflate a drawio-compressed diagram body. drawio applies:
//   encodeURIComponent(xml) → UTF-8 bytes → deflate-raw → base64
// We reverse: atob → inflate → decodeURIComponent.
async function inflateDrawioDiagram(base64: string): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') {
    log('inline-images: DecompressionStream not available — cannot inflate compressed diagram');
    return null;
  }
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const text = await new Response(stream).text();
    return decodeURIComponent(text);
  } catch (e) {
    log('inline-images: inflate failed:', e);
    return null;
  }
}

function tryParseXml(xml: string, context: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.querySelector('parsererror') != null) {
      log(`inline-images: XML parse failed (${context})`);
      return null;
    }
    return doc;
  } catch (e) {
    log(`inline-images: DOMParser threw (${context}):`, e);
    return null;
  }
}

interface ProcessStats {
  inlined: number;
  skipped: number;
  reshapedCells: number;
  styleCandidates: number;
  attrCandidates: number;
  htmlElementsWithImg: number;
}

const EMPTY_STATS: ProcessStats = {
  inlined: 0, skipped: 0, reshapedCells: 0,
  styleCandidates: 0, attrCandidates: 0, htmlElementsWithImg: 0,
};

function mergeStats(a: ProcessStats, b: ProcessStats): ProcessStats {
  return {
    inlined: a.inlined + b.inlined,
    skipped: a.skipped + b.skipped,
    reshapedCells: a.reshapedCells + b.reshapedCells,
    styleCandidates: a.styleCandidates + b.styleCandidates,
    attrCandidates: a.attrCandidates + b.attrCandidates,
    htmlElementsWithImg: a.htmlElementsWithImg + b.htmlElementsWithImg,
  };
}

async function processJobsInDoc(doc: Document): Promise<ProcessStats> {
  const styleRefs: StyleImageRef[] = [];
  const attrRefs: AttrRef[] = [];
  const htmlEls: Element[] = [];
  const urlSet = new Set<string>();

  doc.querySelectorAll<Element>('[style*="image="]').forEach((el) => {
    const style = el.getAttribute('style') ?? '';
    const found = findImageInStyle(style);
    if (!found) return;
    if (/^data:/i.test(found.decoded)) return;
    if (!isSameOrigin(found.decoded)) return;
    styleRefs.push({ el, url: found.decoded });
    urlSet.add(found.decoded);
  });

  doc.querySelectorAll<Element>('UserObject[image], object[image]').forEach((el) => {
    const value = el.getAttribute('image') ?? '';
    if (!value || /^data:/i.test(value)) return;
    if (!isSameOrigin(value)) return;
    attrRefs.push({ el, url: value });
    urlSet.add(value);
  });

  doc.querySelectorAll<Element>('[value]').forEach((el) => {
    const value = el.getAttribute('value') ?? '';
    if (!value.includes('<img')) return;
    const urls = extractImgSrcsFromHtml(value);
    let any = false;
    for (const u of urls) {
      if (/^data:/i.test(u)) continue;
      if (!isSameOrigin(u)) continue;
      urlSet.add(u);
      any = true;
    }
    if (any) htmlEls.push(el);
  });

  const stats: ProcessStats = {
    inlined: 0,
    skipped: 0,
    reshapedCells: 0,
    styleCandidates: styleRefs.length,
    attrCandidates: attrRefs.length,
    htmlElementsWithImg: htmlEls.length,
  };

  if (urlSet.size === 0) return stats;

  const cache = new Map<string, string | null>();
  await Promise.all(
    Array.from(urlSet).map(async (u) => {
      cache.set(u, await fetchAsDataUri(u, 'inline-images'));
    }),
  );

  for (const ref of styleRefs) {
    const dataUri = cache.get(ref.url);
    if (!dataUri) { stats.skipped++; continue; }
    reshapeImageCellToHtmlLabel(ref.el, dataUri);
    stats.inlined++;
    stats.reshapedCells++;
  }
  for (const ref of attrRefs) {
    const dataUri = cache.get(ref.url);
    if (!dataUri) { stats.skipped++; continue; }
    ref.el.setAttribute('image', dataUri);
    stats.inlined++;
  }
  for (const el of htmlEls) {
    const before = el.getAttribute('value') ?? '';
    const { html: after, replaced } = replaceImgSrcsInHtml(before, cache);
    if (replaced > 0) {
      el.setAttribute('value', after);
      stats.inlined += replaced;
    }
  }

  return stats;
}

export async function inlineSameOriginImagesInXml(xml: string): Promise<string> {
  log(`inline-images: start (xmlLen=${xml.length})`);

  const doc = tryParseXml(xml, 'top-level');
  if (doc == null) return xml;

  let stats = EMPTY_STATS;
  let anyDocModified = false;

  const top = await processJobsInDoc(doc);
  stats = mergeStats(stats, top);
  if (top.inlined > 0) anyDocModified = true;

  const diagrams = Array.from(doc.querySelectorAll('diagram'));
  let compressedCount = 0;
  for (const dg of diagrams) {
    const hasElementChild = Array.from(dg.childNodes).some(
      (n) => n.nodeType === Node.ELEMENT_NODE,
    );
    if (hasElementChild) continue;

    const textContent = (dg.textContent ?? '').trim();
    if (!textContent || textContent.startsWith('<')) continue;

    compressedCount++;
    const inflated = await inflateDrawioDiagram(textContent);
    if (inflated == null) continue;

    const innerDoc = tryParseXml(inflated, 'inflated diagram');
    if (innerDoc == null) continue;

    const inner = await processJobsInDoc(innerDoc);
    stats = mergeStats(stats, inner);

    if (inner.inlined === 0) continue;

    const model = innerDoc.querySelector('mxGraphModel');
    if (model == null) {
      log('inline-images: inflated diagram has no <mxGraphModel>, cannot write back');
      continue;
    }
    while (dg.firstChild) dg.removeChild(dg.firstChild);
    dg.appendChild(doc.importNode(model, true));
    anyDocModified = true;
  }

  log(
    `inline-images: done (compressedDiagrams=${compressedCount}, ` +
      `styleCand=${stats.styleCandidates}, attrCand=${stats.attrCandidates}, ` +
      `htmlEls=${stats.htmlElementsWithImg}, reshapedCells=${stats.reshapedCells}, ` +
      `inlined=${stats.inlined}, skipped=${stats.skipped}, modified=${anyDocModified})`,
  );

  if (!anyDocModified) return xml;
  return new XMLSerializer().serializeToString(doc);
}

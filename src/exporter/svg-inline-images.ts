// src/exporter/svg-inline-images.ts
// Inline same-origin image references in an SVG string as base64 data
// URIs so the SVG is self-contained when opened outside this app.
// Covers two reference sites in drawio-produced SVG:
//   1. SVG `<image xlink:href="URL">` / `<image href="URL">` — emitted
//      for shape=image cells.
//   2. HTML `<img src="URL">` inside `<foreignObject>` — emitted for
//      html=1 labels.
// Cross-origin hrefs are left alone; the downloaded SVG will show
// broken icons for those in external viewers that can't reach the URL.
import { isSameOrigin, fetchAsDataUri } from './image-fetch';

// Matches <image ... xlink:href="URL" ...> or <image ... href="URL" ...>
const IMAGE_HREF_REGEX =
  /(<image\b[^>]*?\s)(xlink:)?href\s*=\s*(["'])([^"']*)\3([^>]*>)/gi;

// `\s` before `src` prevents false matches on attribute names like
// `data-src` or `srcset`.
const HTML_IMG_SRC_REGEX = /<img\b[^>]*?\ssrc\s*=\s*(["'])([^"']+)\1/gi;

export interface InlineSvgResult {
  svg: string;
  inlined: string[];
  skipped: string[];
}

export async function inlineSameOriginImagesInSvg(svgString: string): Promise<InlineSvgResult> {
  const inlined: string[] = [];
  const skipped: string[] = [];
  const urls = new Set<string>();

  for (const m of svgString.matchAll(IMAGE_HREF_REGEX)) {
    const href = m[4];
    if (/^data:/i.test(href)) continue;
    if (isSameOrigin(href)) urls.add(href);
    else skipped.push(href);
  }

  HTML_IMG_SRC_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_IMG_SRC_REGEX.exec(svgString)) != null) {
    const src = m[2];
    if (/^data:/i.test(src)) continue;
    if (isSameOrigin(src)) urls.add(src);
    else skipped.push(src);
  }

  if (urls.size === 0) {
    return { svg: svgString, inlined, skipped };
  }

  const cache = new Map<string, string>();
  await Promise.all(
    Array.from(urls).map(async (u) => {
      const dataUri = await fetchAsDataUri(u, 'svg-inline-images');
      if (dataUri) {
        cache.set(u, dataUri);
        inlined.push(u);
      } else {
        skipped.push(`${u} (fetch failed)`);
      }
    }),
  );

  let result = svgString.replace(
    IMAGE_HREF_REGEX,
    (full, pre: string, xlink: string | undefined, quote: string, href: string, post: string) => {
      if (/^data:/i.test(href)) return full;
      const dataUri = cache.get(href);
      if (!dataUri) return full;
      return `${pre}${xlink ?? ''}href=${quote}${dataUri}${quote}${post}`;
    },
  );

  result = result.replace(HTML_IMG_SRC_REGEX, (full, quote: string, src: string) => {
    const dataUri = cache.get(src);
    if (!dataUri) return full;
    const suffix = `${quote}${src}${quote}`;
    if (!full.endsWith(suffix)) return full;
    return full.slice(0, full.length - suffix.length) + `${quote}${dataUri}${quote}`;
  });

  return { svg: result, inlined, skipped };
}

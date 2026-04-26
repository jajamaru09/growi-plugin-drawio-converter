// src/exporter/image-fetch.ts
// Shared helpers for fetching same-origin images as base64 data URIs.
// Used by both png-legacy (SVG <image href> inlining) and png-embed
// (XML style/value inlining) to keep origin checks and fetch semantics
// aligned across the two export paths.
import { log } from '../logger';

const IMAGE_FETCH_TIMEOUT_MS = 10000;

export function isSameOrigin(url: string): boolean {
  if (!url) return false;
  if (/^data:/i.test(url)) return false;
  // Any URL without an explicit scheme is relative → same-origin
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin;
  } catch {
    return false;
  }
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => resolve(reader.result as string);
    reader.onerror = (): void => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function fetchAsDataUri(url: string, logPrefix: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (!res.ok) {
      log(`${logPrefix}: ${url} → HTTP ${res.status}`);
      return null;
    }
    const blob = await res.blob();
    return await blobToDataUri(blob);
  } catch (e) {
    log(`${logPrefix}: ${url} fetch failed:`, e);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

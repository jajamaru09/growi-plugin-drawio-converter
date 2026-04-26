// src/exporter/png-embed/embed-protocol.ts
// Promise-based wrapper over the drawio Editor embed postMessage API.
// ref: https://www.drawio.com/doc/faq/embed-mode
//
// All message handlers enforce origin and source isolation — they only
// react to messages whose event.source === frameWindow AND
// event.origin === targetOrigin. Any other message is silently ignored.
import { log } from '../../logger';

export interface ExportOpts {
  scale: number;
  bg: string;
  format: 'png';
}

export interface ProtocolTimeouts {
  load: number;   // {event:'load'} 受信までの ms
  export: number; // {event:'export'} 受信までの ms
}

// When the iframe URL includes `configure=1`, drawio fires a {event:'configure'}
// message before {event:'init'} and waits for the host to respond with
// {action:'configure', config: ...}. Pass `config` to opt into that flow
// (e.g. to disable fitDiagramOnLoad — see editor-frame.ts).
// ref: https://www.drawio.com/doc/faq/configure-diagram-editor
export function waitForInit(
  frameWindow: Window,
  targetOrigin: string,
  timeoutMs: number,
  config?: object,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`embed-protocol: init timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(e: MessageEvent): void {
      if (e.source !== frameWindow) return;
      if (e.origin !== targetOrigin) return;
      const data = parseMessage(e.data);
      if (!data) return;
      if (data.event === 'configure' && config != null) {
        send(frameWindow, targetOrigin, { action: 'configure', config });
        return;
      }
      if (data.event !== 'init') return;
      window.clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve();
    }

    window.addEventListener('message', handler);
  });
}

export function requestExport(
  frameWindow: Window,
  targetOrigin: string,
  xml: string,
  opts: ExportOpts,
  timeouts: ProtocolTimeouts,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stage: 'awaiting-load' | 'awaiting-export' = 'awaiting-load';

    const timer = window.setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error(`embed-protocol: ${stage} timeout`));
    }, timeouts.load);
    let currentTimer = timer;

    function handler(e: MessageEvent): void {
      if (e.source !== frameWindow) return;
      if (e.origin !== targetOrigin) return;
      const data = parseMessage(e.data);
      if (!data) return;

      if (stage === 'awaiting-load' && data.event === 'load') {
        window.clearTimeout(currentTimer);
        stage = 'awaiting-export';
        currentTimer = window.setTimeout(() => {
          window.removeEventListener('message', handler);
          reject(new Error('embed-protocol: awaiting-export timeout'));
        }, timeouts.export);
        send(frameWindow, targetOrigin, {
          action: 'export',
          format: opts.format,
          scale: opts.scale,
          // drawio reads `data.background` here, NOT `data.bg`. Earlier code
          // sent `bg` and got transparent PNGs back, which is why
          // flattenOntoBackground exists in index.ts as defense — that step
          // remains as a safety net but should now usually be a no-op.
          background: opts.bg,
        });
        return;
      }

      if (stage === 'awaiting-export' && data.event === 'export') {
        window.clearTimeout(currentTimer);
        window.removeEventListener('message', handler);
        const dataUrl = typeof data.data === 'string' ? data.data : '';
        if (!dataUrl.startsWith('data:image/png;base64,')) {
          reject(new Error(`embed-protocol: invalid export data (prefix mismatch, length=${dataUrl.length})`));
          return;
        }
        resolve(dataUrl);
        return;
      }
    }

    window.addEventListener('message', handler);
    send(frameWindow, targetOrigin, { action: 'load', xml });
  });
}

interface EmbedMessage {
  event?: string;
  data?: unknown;
  [k: string]: unknown;
}

function parseMessage(raw: unknown): EmbedMessage | null {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return parsed as EmbedMessage;
    } catch {
      return null;
    }
    return null;
  }
  if (typeof raw === 'object' && raw !== null) return raw as EmbedMessage;
  return null;
}

function send(target: Window, origin: string, payload: object): void {
  const serialized = JSON.stringify(payload);
  log(`embed-protocol: send → ${origin} ${serialized.slice(0, 120)}${serialized.length > 120 ? '…' : ''}`);
  target.postMessage(serialized, origin);
}

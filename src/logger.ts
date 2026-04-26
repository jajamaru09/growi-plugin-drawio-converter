// src/logger.ts
import type { GrowiPluginHub } from './types';

const PLUGIN_ID = 'drawio-converter';

function isReadyHub(h: unknown): h is GrowiPluginHub {
  return (
    typeof h === 'object' &&
    h !== null &&
    'log' in h &&
    typeof (h as GrowiPluginHub).log === 'function'
  );
}

export function log(...args: unknown[]): void {
  const hub = window.growiPluginHub;
  if (isReadyHub(hub)) {
    hub.log(PLUGIN_ID, ...args);
  } else {
    console.log(`[${PLUGIN_ID}]`, ...args);
  }
}

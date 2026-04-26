// src/hub/wait-for-hub.ts
import type { GrowiPluginHub, GrowiPluginHubQueue, PluginRegistration } from '../types';

function isReadyHub(h: unknown): h is GrowiPluginHub {
  return (
    typeof h === 'object' &&
    h !== null &&
    'register' in h &&
    typeof (h as GrowiPluginHub).register === 'function'
  );
}

export function registerToHub(plugin: PluginRegistration): void {
  const hub = window.growiPluginHub;
  if (isReadyHub(hub)) {
    hub.register(plugin);
    return;
  }
  const queue = (window.growiPluginHub as GrowiPluginHubQueue | undefined) ?? { _queue: [] };
  queue._queue.push(plugin);
  window.growiPluginHub = queue;
}

export function unregisterFromHub(id: string): void {
  const hub = window.growiPluginHub;
  if (isReadyHub(hub)) {
    hub.unregister(id);
  }
  // if hub not ready, plugin is still in queue; no-op (activate/deactivate pair won't happen in that state)
}

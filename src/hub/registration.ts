// src/hub/registration.ts
import type { GrowiPluginHub, GrowiPageContext, PluginRegistration } from '../types';
import { log } from '../logger';
import { onPageChange, cleanup } from '../dom/button-injector';
import { registerToHub, unregisterFromHub } from './wait-for-hub';

export const PLUGIN_ID = 'drawio-converter';

// GROWI page IDs are 24-char hex ObjectIds, addressed at paths like
// `/<objectId>`. Other paths (e.g. `/Wiki/Foo`) are not dispatched by the hub,
// so we also skip self-trigger for them.
const OBJECT_ID_PATH_REGEX = /^\/[0-9a-f]{24}$/i;

function isReadyHub(h: unknown): h is GrowiPluginHub {
  return (
    typeof h === 'object' &&
    h !== null &&
    'api' in h &&
    typeof (h as GrowiPluginHub).api?.fetchPageIdByPath === 'function'
  );
}

export function register(): void {
  const plugin: PluginRegistration = {
    id: PLUGIN_ID,
    label: 'Drawio Converter',
    menuItem: false,
    onPageChange: (ctx) => {
      onPageChange(ctx);
    },
    onDisable: () => {
      log('disabled');
      cleanup();
    },
  };
  registerToHub(plugin);
  log('hub registered (menuItem: false)');

  // PluginHub は遅れて register されたプラグインに過去の page-change を
  // リプレイしない。初回ロード時に登録が page-change イベントに間に合わ
  // ないとボタン注入が走らないため、現在 URL から ctx を合成して自前で
  // 初回 scan を発火する。
  //
  // 非同期:
  //   - `/` (root) の場合は hub.api.fetchPageIdByPath で実 pageId を解決する
  //     (hub 自身も navigation.ts:resolveAndDispatch で同じ処理をしている)。
  //   - `/<ObjectId>` 形式はそのまま pageId として使う。
  //   - それ以外の path (`/Wiki/Foo` 等) は hub も dispatch しないので self-
  //     trigger もスキップする。
  void selfTriggerInitialPageChange();
}

export function unregister(): void {
  cleanup();
  unregisterFromHub(PLUGIN_ID);
}

async function selfTriggerInitialPageChange(): Promise<void> {
  const pathname = window.location.pathname;
  if (!pathname) return;

  const ctx = await resolveInitialContext(pathname);
  if (!ctx) {
    log(`self-trigger skipped: pathname=${pathname} is not dispatchable`);
    return;
  }

  log('self-trigger initial onPageChange:', ctx);
  onPageChange(ctx);
}

async function resolveInitialContext(
  pathname: string,
): Promise<GrowiPageContext | null> {
  if (pathname === '/') {
    const hub = window.growiPluginHub;
    if (!isReadyHub(hub)) {
      // Hub not ready yet — our registration was queued and the hub will
      // fire fireCurrentPage() to us after init. No self-trigger needed.
      return null;
    }
    try {
      const resolved = await hub.api.fetchPageIdByPath('/');
      if (!resolved) {
        log('self-trigger: fetchPageIdByPath returned null for /');
        return null;
      }
      return { pageId: `/${resolved}`, mode: 'view', path: '/' };
    } catch (e) {
      log('self-trigger: fetchPageIdByPath failed for /:', e);
      return null;
    }
  }

  if (OBJECT_ID_PATH_REGEX.test(pathname)) {
    return { pageId: pathname, mode: 'view' };
  }

  return null;
}

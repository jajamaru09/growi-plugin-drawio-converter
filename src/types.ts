// src/types.ts

// ================== extension-hub types ==================
// Minimal subset from https://gitea.drupal-yattemiyo.com/growi-plugins/growi-plugin-extension-hub

export interface GrowiPageContext {
  pageId: string;
  mode: 'view' | 'edit';
  revisionId?: string;
  path?: string;
}

export interface PluginRegistration {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  menuItem?: boolean;
  onAction?: (pageId: string) => void;
  onPageChange?: (ctx: GrowiPageContext) => void | Promise<void>;
  onDisable?: () => void;
}

export interface PageInfo {
  _id: string;
  path: string;
  revision?: { _id: string; body: string };
}

export interface HubApi {
  fetchPageIdByPath(path: string, signal?: AbortSignal): Promise<string | null>;
  fetchPageInfo(pageId: string, signal?: AbortSignal): Promise<PageInfo | null>;
}

export interface GrowiPluginHub {
  register(plugin: PluginRegistration): void;
  unregister(id: string): void;
  log(pluginId: string, ...args: unknown[]): void;
  api: HubApi;
}

export interface GrowiPluginHubQueue {
  _queue: PluginRegistration[];
}

declare global {
  interface Window {
    growiPluginHub?: GrowiPluginHub | GrowiPluginHubQueue;
    pluginActivators?: Record<string, { activate: () => void; deactivate: () => void }>;
    GraphViewer?: GraphViewerGlobal;
  }
}

// ================== GraphViewer types ==================

export interface GraphGetSvg {
  getSvg(
    background: string | null,
    scale: number,
    border: number,
    nocrop: boolean,
    crisp: unknown | null,
    ignoreSelection: boolean,
    showText: boolean,
    imgExport: unknown | null,
    linkTarget: unknown | null,
    hasShadow: boolean,
    incExtFonts: boolean,
    keepTheme: boolean,
  ): SVGSVGElement;
}

export interface Viewer {
  graph?: GraphGetSvg;
}

export interface GraphViewerGlobal {
  createViewerForElement(element: Element, callback?: (viewer: Viewer) => void): void;
  processElements(): void;
  useResizeSensor: boolean;
  prototype: {
    checkVisibleState: boolean;
    lightboxZIndex: number;
    toolbarZIndex: number;
  };
}

// ================== internal types ==================

export interface DiagramMeta {
  wrapperEl: HTMLElement;
  mxgraphDataAttr: string;  // raw data-mxgraph attribute value (JSON string)
  xml: string;              // parsed mxfile xml
  pageId: string;           // sanitized (no leading slash)
  revisionId: string;       // resolved, never empty in meta (caller ensures)
  blockIndex: number;       // 1-indexed among wrappers in current page
}

export interface ExportOptions {
  isDarkMode: boolean;
  // External font embedding. Default true for SVG (high fidelity when opened elsewhere).
  // PNG path sets false to avoid canvas tainting via cross-origin @font-face fetches.
  incExtFonts?: boolean;
}

export type ProbeResult = 'unknown' | 'available' | 'unavailable';

// client-entry.tsx
import { activate, deactivate } from './src/activate';

const PLUGIN_NAME = 'growi-plugin-drawio-converter';

if (window.pluginActivators == null) {
  window.pluginActivators = {};
}

window.pluginActivators[PLUGIN_NAME] = { activate, deactivate };

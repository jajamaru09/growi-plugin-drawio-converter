// src/activate.ts
import { register, unregister } from './hub/registration';
import { log } from './logger';

export function activate(): void {
  log('activated');
  register();
}

export function deactivate(): void {
  log('deactivated');
  unregister();
}

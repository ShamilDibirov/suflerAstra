import { EventEmitter } from 'node:events';
import type { AppEvent } from '@sufler/shared';
export const events = new EventEmitter();
events.setMaxListeners(100);
export function emit(org: string, userId: string, event: AppEvent) {
  events.emit(`${org}:${userId}`, event);
}

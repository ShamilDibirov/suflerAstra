import type { AppEvent } from '@sufler/shared';
export function isAudioFailure(event: AppEvent) {
  return event.type === 'error' && event.scope === 'audio';
}

export function shouldRetrySpeech(event: AppEvent, attempts: number, paused: boolean) {
  return isAudioFailure(event) && event.recoverable === true && attempts < 3 && !paused;
}

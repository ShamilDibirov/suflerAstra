import { it, expect } from 'vitest';
import { isAudioFailure, shouldRetrySpeech } from '../apps/web/src/lib/audio-events';
it('only audio failures stop capture; hint and storage failures leave it running', () => {
  expect(isAudioFailure({ type: 'error', scope: 'audio', data: 'Connection lost' })).toBe(true);
  expect(isAudioFailure({ type: 'error', scope: 'assistant', data: 'LLM unavailable' })).toBe(
    false,
  );
  expect(isAudioFailure({ type: 'error', scope: 'storage', data: 'S3 unavailable' })).toBe(false);
  expect(isAudioFailure({ type: 'error', data: 'General failure' })).toBe(false);
});

it('retries only transient speech failures and respects pause and retry limits', () => {
  const event = {
    type: 'error' as const,
    scope: 'audio' as const,
    recoverable: true,
    data: 'ConnectionClosed',
  };
  expect(shouldRetrySpeech(event, 0, false)).toBe(true);
  expect(shouldRetrySpeech(event, 3, false)).toBe(false);
  expect(shouldRetrySpeech(event, 0, true)).toBe(false);
  expect(shouldRetrySpeech({ ...event, recoverable: false }, 0, false)).toBe(false);
});

import { it, expect } from 'vitest';
import { newConversation } from '@sufler/shared/engine';
import { acceptConversation } from './conversation-state';
it('does not let a delayed poll erase a hint delivered by WebSocket or revert a new generation', () => {
  const old = newConversation('o', 'u', 'q', 'Client');
  const current = { ...old, hints: [{ id: 'hint' }] as typeof old.hints };
  expect(acceptConversation(current, old)).toBe(current);
  const changed = { ...current, generationEpoch: current.generationEpoch + 1 };
  expect(acceptConversation(changed, current)).toBe(changed);
  const next = newConversation('o', 'u', 'q', 'Next');
  expect(acceptConversation(current, next)).toBe(next);
});

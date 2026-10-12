import type { Conversation } from '@sufler/shared';
/** Polling can finish after a newer WebSocket event with the same card revision. */
export function acceptConversation(previous: Conversation | null, incoming: Conversation) {
  if (!previous || previous.id !== incoming.id) return incoming;
  if (
    incoming.card.revision < previous.card.revision ||
    incoming.generationEpoch < previous.generationEpoch ||
    incoming.hints.length < previous.hints.length ||
    incoming.messages.length < previous.messages.length ||
    incoming.segments.length < previous.segments.length ||
    incoming.recordings.length < previous.recordings.length
  )
    return previous;
  return incoming;
}

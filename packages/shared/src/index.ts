import { z } from 'zod';

export const Direction = z.enum(['unknown', 'service', 'sales', 'mixed']);
export const Stage = z.enum(['discovery', 'clarification', 'resolution', 'offer', 'completed']);
export const Role = z.enum(['consultant', 'customer', 'bystander', 'unknown']);
export const SegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(4000),
  role: Role,
  speakerId: z.string().default('manual'),
  startMs: z.number().nonnegative().default(0),
  endMs: z.number().nonnegative().default(0),
  confidence: z.number().min(0).max(1).default(1),
  final: z.boolean().default(true),
  excluded: z.boolean().default(false),
  createdAt: z.string(),
});
export type TranscriptSegment = z.infer<typeof SegmentSchema>;
export const FactSchema = z.object({
  key: z.string().max(80),
  value: z.string().max(240),
  quote: z.string().max(400),
  segmentId: z.string(),
});
export const PatchSchema = z.object({
  direction: Direction,
  intent: z.string().max(100),
  secondaryIntents: z.array(z.string()).max(5).default([]),
  stage: Stage,
  needs: z.array(z.string().max(100)).max(6).default([]),
  objections: z.array(z.string().max(100)).max(5).default([]),
  missing: z.array(z.string().max(100)).max(6).default([]),
  facts: z.array(FactSchema).max(12).default([]),
  shouldHint: z.boolean(),
  ending: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
});
export type ConversationStatePatch = z.infer<typeof PatchSchema>;
export interface ConversationCard {
  id: string;
  label: string;
  revision: number;
  direction: z.infer<typeof Direction>;
  intent: string;
  secondaryIntents: string[];
  stage: z.infer<typeof Stage>;
  needs: string[];
  objections: string[];
  missing: string[];
  facts: z.infer<typeof FactSchema>[];
  completedSteps: string[];
  shownOffers: string[];
  activeProcessId: string | null;
  ending: boolean;
  classificationSource: 'kev' | 'qwen' | 'demo' | 'manual' | null;
  confidence: number | null;
  evidenceSegmentIds: string[];
  updatedAt: string;
}
export interface KnowledgeBlock {
  id: string;
  text: string;
  kind: 'step' | 'fact' | 'offer' | 'question';
  requiredFacts: string[];
  urgent?: boolean;
}
export const KnowledgeInput = z.object({
  title: z.string().trim().min(3).max(160),
  type: z.enum(['article', 'process', 'catalog']),
  intent: z.string().trim().min(1).max(100),
  direction: Direction.default('service'),
  description: z.string().max(1000).default(''),
  region: z.string().max(80).default('Все регионы'),
  content: z.string().trim().min(10).max(150000),
  validFrom: z.union([z.iso.date(), z.literal('')]).default(''),
  validUntil: z.union([z.iso.date(), z.literal('')]).default(''),
  blocks: z
    .array(
      z.object({
        id: z.string().optional(),
        text: z.string().min(1).max(2000),
        kind: z.enum(['step', 'fact', 'offer', 'question']),
        requiredFacts: z.array(z.string()).default([]),
        urgent: z.boolean().default(false),
      }),
    )
    .max(200)
    .optional(),
});
export interface KnowledgeDocument {
  id: string;
  orgId: string;
  title: string;
  type: 'article' | 'process' | 'catalog';
  intent: string;
  direction: z.infer<typeof Direction>;
  description: string;
  region: string;
  content: string;
  blocks: KnowledgeBlock[];
  status: 'draft' | 'review' | 'published' | 'archived' | 'processing' | 'failed';
  version: number;
  validFrom: string;
  validUntil: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  sourceName: string | null;
  sourceKey: string | null;
  error: string | null;
  indexedVersion: number | null;
}
export interface EvidenceRef {
  documentId: string;
  version: number;
  blockId: string;
  title: string;
  quote: string;
  region: string;
  catalogDate?: string;
}
export interface Hint {
  id: string;
  revision: number;
  kind: 'service' | 'sales' | 'clarify' | 'no_evidence';
  title: string;
  text: string;
  blocks: EvidenceRef[];
  modelId: string;
  createdAt: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  status: 'current' | 'stale';
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  hint?: Hint;
  createdAt: string;
}
export interface Conversation {
  id: string;
  orgId: string;
  userId: string;
  status: 'active' | 'completed';
  createdAt: string;
  endedAt: string | null;
  card: ConversationCard;
  segments: TranscriptSegment[];
  hints: Hint[];
  messages: ChatMessage[];
  modelId: string;
  assistanceMode?: 'rag' | 'scripts';
  salesScriptId?: string | null;
  region?: string;
  autoHints: boolean;
  lastAutoHintAt: number;
  generationEpoch: number;
  error: string | null;
  recordings: { key: string; startMs: number; endMs: number }[];
}
export const ModelInput = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9._:-]+\/[a-zA-Z0-9._:/-]+$/)
    .max(140),
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
});
export type ModelConfig = z.infer<typeof ModelInput> & {
  testedAt: string | null;
  testError: string | null;
};
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'consultant';
  orgId: string;
  orgName: string;
  demo: boolean;
}
export interface AppEvent {
  type:
    | 'conversation.updated'
    | 'transcript.partial'
    | 'audio.status'
    | 'session.boundary'
    | 'error';
  conversationId?: string;
  data: unknown;
}
export const MODEL_DEFAULTS: ModelConfig[] = [
  {
    id: 'qwen/qwen3.5-9b',
    name: 'Qwen 3.5 · 9B',
    enabled: true,
    isDefault: true,
    testedAt: null,
    testError: null,
  },
  {
    id: 'qwen/qwen3.5-35b-a3b',
    name: 'Qwen 3.5 · 35B',
    enabled: true,
    isDefault: false,
    testedAt: null,
    testError: null,
  },
  {
    id: 'moonshotai/kimi-k2.5',
    name: 'Kimi K2.5',
    enabled: true,
    isDefault: false,
    testedAt: null,
    testError: null,
  },
];
export const directionLabels = {
  unknown: 'Уточняем запрос',
  service: 'Сервис',
  sales: 'Продажи',
  mixed: 'Сервис + продажи',
};
export const stageLabels = {
  discovery: 'Знакомство',
  clarification: 'Уточнение',
  resolution: 'Решение',
  offer: 'Предложение',
  completed: 'Завершение',
};
export const roleLabels = {
  consultant: 'Консультант',
  customer: 'Клиент',
  bystander: 'Посторонний',
  unknown: 'Не определён',
};
export const NO_EVIDENCE =
  'В опубликованной базе нет подтверждённого ответа. Уточните запрос или обратитесь к администратору базы знаний.';

export function encodeAudioFrame(
  pcm: ArrayBuffer,
  sequence: number,
  startSample: number,
): ArrayBuffer {
  const result = new ArrayBuffer(pcm.byteLength + 12),
    view = new DataView(result);
  view.setUint32(0, 0x53554631, true);
  view.setUint32(4, sequence, true);
  view.setUint32(8, startSample, true);
  new Uint8Array(result, 12).set(new Uint8Array(pcm));
  return result;
}
export function decodeAudioFrame(
  frame: Uint8Array,
  sequence: number,
  startSample: number,
): Uint8Array {
  if (frame.byteLength < 14 || frame.byteLength > 6412 || (frame.byteLength - 12) % 2)
    throw new Error('Неверный PCM-фрагмент');
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (
    view.getUint32(0, true) !== 0x53554631 ||
    view.getUint32(4, true) !== sequence ||
    view.getUint32(8, true) !== startSample
  )
    throw new Error('Нарушена последовательность аудио. Запустите микрофон снова.');
  return frame.subarray(12);
}

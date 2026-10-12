/** Explicit paid evaluation against the configured Decision provider; synthetic Russian cases. */
import { readFile } from 'node:fs/promises';
import { inferBoundary } from './ai';
import { config } from './config';
import { newConversation } from '@sufler/shared/engine';
import { SegmentSchema } from '@sufler/shared';
if (config.demo || !config.dashscope)
  throw new Error(
    'Для оценки задайте DEMO_MODE=false и DASHSCOPE_API_KEY. Эта команда вызывает реальный API.',
  );
const cases = JSON.parse(
  await readFile(new URL('../../../eval/ru-boundaries.json', import.meta.url), 'utf8'),
) as { id: string; expected: number | null; turns: string[] }[];
let correct = 0,
  falsePositive = 0,
  falseNegative = 0;
for (const test of cases) {
  const c = newConversation('evaluation', 'evaluation', config.fallback, test.id);
  c.segments = test.turns.map((text, i) =>
    SegmentSchema.parse({
      id: `s${i}`,
      text,
      role: 'unknown',
      roleInference: true,
      speakerId: `speaker:${i % 2}`,
      startMs: i * 3000,
      endMs: i * 3000 + 2000,
      confidence: 0.99,
      createdAt: new Date().toISOString(),
    }),
  );
  const actual = await inferBoundary(c, new AbortController().signal),
    expected = test.expected === null ? null : `s${test.expected}`;
  const ok = actual === expected;
  if (ok) correct++;
  if (expected === null && actual !== null) falsePositive++;
  if (expected !== null && actual === null) falseNegative++;
  console.log(JSON.stringify({ case: test.id, expected, actual, ok }));
}
console.log(
  JSON.stringify({
    correct,
    total: cases.length,
    falsePositive,
    falseNegative,
    threshold: 0.9,
    note: 'Small development set; not an independent production-quality benchmark.',
  }),
);

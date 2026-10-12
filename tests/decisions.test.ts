import { describe, expect, it } from 'vitest';
import {
  ClassificationInput,
  DEFAULT_CLASSIFICATION,
  PatchSchema,
} from '../packages/shared/src/index';
import {
  decisionQuestion,
  decisionLabel,
  decisionPassed,
  accumulateDecisionLabels,
  type DecisionRule,
} from '../packages/shared/src/decisions';
const base: DecisionRule = {
  id: 'test',
  name: 'Test',
  instructions: 'Question?',
  enabled: true,
  choices: [
    { id: 'a', name: 'A', description: 'Case A' },
    { id: 'b', name: 'B', description: 'Case B' },
  ],
};
describe('decision builder live contract', () => {
  it('keeps old choice rules compatible and sends explicit criteria plus unknown', () => {
    const parsed = ClassificationInput.parse({ ...DEFAULT_CLASSIFICATION, groups: [base] });
    expect(decisionQuestion(parsed.groups[0]).criteria).toEqual({
      a: 'A: Case A',
      b: 'B: Case B',
      unknown: 'Недостаточно данных / ни один вариант не подходит',
    });
    expect(
      decisionLabel(base, { type: 'choice', choice: 'invented', confidence: 1 }, 0.85).value,
    ).toBe('unknown');
    expect(
      decisionLabel(
        { ...base, threshold: 0.95 },
        { type: 'choice', choice: 'a', confidence: 0.9 },
        0.85,
      ).value,
    ).toBe('unknown');
  });
  it('sends both noul criteria, distinguishes uncertain from no and applies own threshold', () => {
    const rule: DecisionRule = {
      ...base,
      type: 'noul',
      trueWhen: 'Asked',
      falseWhen: 'Not asked',
      choices: [],
    };
    expect(decisionQuestion(rule).criteria).toEqual({ true: 'Asked', false: 'Not asked' });
    expect(decisionLabel(rule, { type: 'noul', noul: 0.5 }, 0.85).value).toBe('unknown');
    expect(decisionLabel(rule, { type: 'noul', noul: 0.95 }, 0.85).value).toBe('true');
    expect(decisionLabel(rule, { type: 'noul', noul: 0.05 }, 0.85).value).toBe('false');
    expect(decisionPassed(rule, { type: 'noul', noul: 0.05 }, 0.85)).toBe(false);
    expect(decisionPassed(rule, { type: 'noul', noul: 0.5 }, 0.85)).toBeNull();
  });
  it('preserves ordered rubric, fractional scores and rejects out of range or low confidence', () => {
    const rule: DecisionRule = {
      ...base,
      type: 'score',
      levels: ['Browsing', 'Comparing', 'Ready', 'Buying'],
      scoreThreshold: 2,
      choices: [],
    };
    expect(decisionQuestion(rule).criteria).toEqual(rule.levels);
    const answer = { type: 'score' as const, score: 2.25, confidence: 0.95 };
    expect(decisionLabel(rule, answer, 0.85).value).toBe('2.25');
    expect(decisionPassed(rule, answer, 0.85)).toBe(true);
    expect(decisionPassed(rule, { ...answer, score: 1.8 }, 0.85)).toBe(false);
    expect(decisionPassed(rule, { ...answer, score: 4 }, 0.85)).toBeNull();
    expect(decisionPassed(rule, { ...answer, confidence: 0.5 }, 0.85)).toBeNull();
    expect(decisionLabel(rule, { type: 'noul', noul: 1 }, 0.85).value).toBe('unknown');
  });
  it('fits a long rubric result into the card without truncating model criteria', () => {
    const rule: DecisionRule = {
      ...base,
      type: 'score',
      levels: ['Low', 'x'.repeat(400)],
      scoreThreshold: 1,
      choices: [],
    };
    const label = decisionLabel(rule, { type: 'score', score: 1, confidence: 0.96 }, 0.85);
    expect(label.label.length).toBe(100);
    expect((decisionQuestion(rule).criteria as string[])[1]).toHaveLength(400);
    expect(() =>
      PatchSchema.parse({
        direction: 'sales',
        intent: 'unknown',
        stage: 'discovery',
        shouldHint: true,
        confidence: 0.96,
        labels: [label],
      }),
    ).not.toThrow();
  });
  it('rejects empty rubrics, missing binary conditions and thresholds outside the scale', () => {
    const input = (group: unknown) => ({ ...DEFAULT_CLASSIFICATION, groups: [group] });
    expect(() => ClassificationInput.parse(input({ ...base, type: 'noul' }))).toThrow();
    expect(() =>
      ClassificationInput.parse(
        input({ ...base, type: 'score', levels: ['one'], scoreThreshold: 0 }),
      ),
    ).toThrow();
    expect(() =>
      ClassificationInput.parse(
        input({ ...base, type: 'score', levels: ['one', 'two'], scoreThreshold: 2 }),
      ),
    ).toThrow();
    expect(() => ClassificationInput.parse(input({ ...base, choices: [] }))).toThrow();
  });
});

describe('independent classifiers and optional memory', () => {
  it('combines different classifiers by key, preserves known values only when enabled, and accepts corrections', () => {
    const sticky = { ...base, id: 'device', remember: true };
    const current = { ...base, id: 'need', remember: false };
    const first = accumulateDecisionLabels(
      [sticky, current],
      [
        decisionLabel(sticky, { type: 'choice', choice: 'a', confidence: 0.97 }, 0.85),
        decisionLabel(current, { type: 'choice', choice: 'b', confidence: 0.96 }, 0.85),
      ],
      [],
    );
    const next = accumulateDecisionLabels([sticky, current], [], first);
    expect(next.map((v) => v.value)).toEqual(['a', 'unknown']);
    expect(next[0]).toHaveProperty('retained', true);
    const corrected = accumulateDecisionLabels(
      [sticky, current],
      [decisionLabel(sticky, { type: 'choice', choice: 'b', confidence: 0.99 }, 0.85)],
      first,
    );
    expect(corrected[0].value).toBe('b');
    expect(corrected[0]).not.toHaveProperty('retained');
    expect(accumulateDecisionLabels([{ ...sticky, enabled: false }], [], first)).toEqual([]);
    expect(
      accumulateDecisionLabels([{ ...sticky, instructions: 'A different question' }], [], first)[0]
        .value,
    ).toBe('unknown');
    expect(accumulateDecisionLabels([{ ...sticky, threshold: 0.99 }], [], first)[0].value).toBe(
      'unknown',
    );
    expect(accumulateDecisionLabels([sticky], [], [])[0].value).toBe('unknown');
  });
  it('stores 32 independent classifiers without collapsing them into intent', () => {
    const rules = Array.from({ length: 32 }, (_, i) => ({ ...base, id: `group_${i}` }));
    expect(
      ClassificationInput.parse({ ...DEFAULT_CLASSIFICATION, groups: rules }).groups,
    ).toHaveLength(32);
    const labels = rules.map((g) =>
      decisionLabel(g, { type: 'choice', choice: 'a', confidence: 0.99 }, 0.85),
    );
    expect(
      PatchSchema.parse({
        direction: 'sales',
        intent: 'tariff_selection',
        stage: 'offer',
        confidence: 0.95,
        shouldHint: true,
        labels,
      }).labels,
    ).toHaveLength(32);
    expect(() =>
      ClassificationInput.parse({
        ...DEFAULT_CLASSIFICATION,
        groups: [...rules, { ...base, id: 'one_more' }],
      }),
    ).toThrow();
  });
});

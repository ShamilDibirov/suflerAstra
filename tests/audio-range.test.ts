import { it, expect } from 'vitest';
import { audioRange } from '../apps/api/src/audio-range';
it('supports browser seek ranges and rejects unsatisfiable ranges', () => {
  expect(audioRange('bytes=5-10', 20)).toEqual({ start: 5, end: 10 });
  expect(audioRange('bytes=10-', 20)).toEqual({ start: 10, end: 19 });
  expect(audioRange('bytes=-5', 20)).toEqual({ start: 15, end: 19 });
  expect(audioRange('bytes=20-', 20)).toBeNull();
  expect(audioRange('bytes=5-1', 20)).toBeNull();
  expect(audioRange('bytes=0-1,3-5', 20)).toBeNull();
});

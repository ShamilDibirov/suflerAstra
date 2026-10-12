import type { AudioSlice } from '@sufler/shared';
import { getFileRange } from './storage';
export function audioLayout(recordings: AudioSlice[]) {
  let offset = 44;
  const parts = [...recordings]
    .sort((a, b) => a.startMs - b.startMs)
    .map((r) => {
      const bytes = Math.round((r.endMs - r.startMs) * 16) * 2;
      const part = {
        ...r,
        offset,
        bytes,
        sourceOffset: 44 + Math.round((r.startMs - (r.sourceStartMs ?? r.startMs)) * 16) * 2,
      };
      offset += bytes;
      return part;
    });
  if (offset - 8 > 0xffffffff) throw new Error('Запись превышает размер WAV');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(offset - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(offset - 44, 40);
  return { parts, header, length: offset };
}
export async function* audioBytes(
  recordings: AudioSlice[],
  start: number,
  end: number,
  signal?: AbortSignal,
) {
  const { parts, header } = audioLayout(recordings);
  if (start < 44) yield header.subarray(start, Math.min(44, end + 1));
  for (const p of parts) {
    if (signal?.aborted) return;
    const lo = Math.max(start, p.offset),
      hi = Math.min(end, p.offset + p.bytes - 1);
    if (hi < lo) continue;
    yield* getFileRange(
      p.key,
      p.sourceOffset + lo - p.offset,
      p.sourceOffset + hi - p.offset,
      signal,
    );
  }
}

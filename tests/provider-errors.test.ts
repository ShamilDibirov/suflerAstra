import { it, expect } from 'vitest';
import { providerError } from '../apps/api/src/ai';
it('distinguishes provider access, billing and throttling without disclosing payloads', () => {
  for (const code of [401, 402, 403, 429]) {
    const result = providerError({ statusCode: code, message: 'SECRET_KEY' });
    expect(result).toContain(String(code));
    expect(result).not.toContain('SECRET_KEY');
  }
  expect(providerError(new Error('Forbidden'))).toContain('403');
  expect(providerError(new Error('SECRET_KEY'))).not.toContain('SECRET_KEY');
});

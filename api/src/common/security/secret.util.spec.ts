import { describe, expect, it } from 'vitest';
import { generateSecret, hashSecret, verifySecret } from './secret.util.js';

describe('secret.util', () => {
  it('generates unique, high-entropy secrets', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes a secret such that it verifies correctly and rejects wrong values', async () => {
    const secret = generateSecret();
    const hash = await hashSecret(secret);

    expect(await verifySecret(hash, secret)).toBe(true);
    expect(await verifySecret(hash, 'wrong-secret')).toBe(false);
  });

  it('treats a null/undefined hash as never valid, without throwing', async () => {
    expect(await verifySecret(null, 'anything')).toBe(false);
    expect(await verifySecret(undefined, 'anything')).toBe(false);
  });

  it('never verifies against a malformed hash', async () => {
    expect(await verifySecret('not-a-real-argon2-hash', 'anything')).toBe(false);
  });
});

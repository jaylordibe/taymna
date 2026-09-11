import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

/** Generates a URL-safe random secret (32 bytes of entropy). */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifySecret(
  hash: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!hash) return false;
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

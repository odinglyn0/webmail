import { randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import { getStatePath } from '@/lib/admin/paths';

const TOKEN_FILE = '.setup-token';
const TOKEN_BYTES = 32;
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

interface TokenPayload {
  token: string;
  issuedAt: number;
  ttlSeconds: number;
}

function tokenKey(): string {
  return getStatePath(TOKEN_FILE);
}

/**
 * Read the current token if one exists and hasn't expired. Stale tokens
 * are deleted lazily - first stale read removes the file.
 */
async function readToken(): Promise<TokenPayload | null> {
  const storage = getStorage();
  const buf = await storage.get(tokenKey()).catch(() => null);
  if (!buf) return null;
  try {
    const payload = JSON.parse(buf.toString('utf-8')) as TokenPayload;
    if (Date.now() / 1000 - payload.issuedAt > payload.ttlSeconds) {
      try { await storage.del(tokenKey()); } catch { /* ok */ }
      return null;
    }
    return payload;
  } catch (error) {
    logger.warn('Failed to read setup token', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Generate (or refresh) the setup token. Called at startup when the app
 * detects bootstrap state. Idempotent: returns the existing token if it's
 * still valid, otherwise issues a fresh one.
 *
 * The token lands in the state namespace and is also printed to the
 * container logs so the operator can copy it without execing into the
 * container.
 */
export async function ensureSetupToken(ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<string> {
  const existing = await readToken();
  if (existing) return existing.token;

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const payload: TokenPayload = {
    token,
    issuedAt: Math.floor(Date.now() / 1000),
    ttlSeconds,
  };
  await getStorage().put(tokenKey(), JSON.stringify(payload, null, 2));
  return token;
}

/**
 * Verify a token submitted by the wizard. Constant-time comparison; never
 * leak the stored token via timing.
 */
export async function verifySetupToken(submitted: string): Promise<boolean> {
  if (!submitted || typeof submitted !== 'string') return false;
  const stored = await readToken();
  if (!stored) return false;

  const a = Buffer.from(submitted);
  const b = Buffer.from(stored.token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Delete the token. Called by the wizard's finish endpoint after
 * setupComplete=true is persisted.
 */
export async function clearSetupToken(): Promise<void> {
  try {
    await getStorage().del(tokenKey());
  } catch (error) {
    logger.warn('Failed to clear setup token', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * For diagnostics / startup logging.
 */
export async function getTokenInfo(): Promise<{ exists: boolean; expiresInSeconds: number | null }> {
  const payload = await readToken();
  if (!payload) return { exists: false, expiresInSeconds: null };
  const elapsed = Date.now() / 1000 - payload.issuedAt;
  return { exists: true, expiresInSeconds: Math.max(0, Math.floor(payload.ttlSeconds - elapsed)) };
}

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getSessionSecret } from '@/lib/auth/session-secret';
import { getStorage } from '@/lib/storage';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const secret = getSessionSecret();
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return createHash('sha256').update(secret).digest();
}

/**
 * Compute the storage key for a user's settings blob. The username and
 * server URL are hashed together so the on-disk / blob name doesn't
 * leak the user identity, and the result is namespaced under
 * settings/ so it groups cleanly with other app state.
 */
function settingsKey(username: string, serverUrl: string): string {
  const hash = createHash('sha256').update(`${username}:${serverUrl}`).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    // Defensive: should be impossible since createHash returns hex.
    throw new Error('Invalid settings key');
  }
  return `settings/${hash}.enc`;
}

export async function saveUserSettings(username: string, serverUrl: string, settings: Record<string, unknown>): Promise<void> {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const payload = JSON.stringify(settings);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const data = Buffer.concat([iv, tag, encrypted]);
  await getStorage().put(settingsKey(username, serverUrl), data);
}

export async function loadUserSettings(username: string, serverUrl: string): Promise<Record<string, unknown> | null> {
  try {
    const data = await getStorage().get(settingsKey(username, serverUrl));
    if (!data) return null;
    if (data.length < IV_LENGTH + TAG_LENGTH) return null;

    const key = getKey();
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    logger.warn('Failed to load user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
    return null;
  }
}

export async function deleteUserSettings(username: string, serverUrl: string): Promise<void> {
  try {
    await getStorage().del(settingsKey(username, serverUrl));
  } catch (error) {
    logger.warn('Failed to delete user settings', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

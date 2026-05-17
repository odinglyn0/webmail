import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';

/**
 * Logical paths for admin data. With the storage abstraction these are
 * keys, not filesystem paths. The fs backend maps them to files under
 * <storage-root>/admin and <storage-root>/admin-state; the blob backend
 * stores them under the same logical names within its prefix.
 *
 * Two namespaces intentionally split (issue #226):
 *   - CONFIG (admin/...): operator-authored state - config.json, policy.json,
 *     admin.json (passwordHash), plugins/, themes/, plugin-config/, branding
 *     uploads. Can be made read-only via ADMIN_CONFIG_READONLY.
 *   - STATE (admin-state/...): runtime mutations - admin-state.json,
 *     audit.log, .setup-token. Always read-write.
 *
 * Migration note: the legacy ADMIN_CONFIG_DIR / ADMIN_DATA_DIR /
 * ADMIN_STATE_DIR env vars are no longer honored by the abstraction. On
 * Docker, mount your persistent volume at <cwd>/data and existing
 * subdirectory layouts (data/admin, data/admin-state) keep working
 * without code changes since the fs backend's root is <cwd>/data.
 *
 * If you need to relocate state on Docker, set STORAGE_FS_ROOT (handled
 * inside the storage module).
 */

export function getConfigPath(filename: string): string {
  return `admin/${filename}`;
}

export function getStatePath(filename: string): string {
  return `admin-state/${filename}`;
}

/** @deprecated The storage backend handles namespace creation. */
export async function ensureConfigDir(): Promise<void> {
  // No-op
}

/** @deprecated The storage backend handles namespace creation. */
export async function ensureStateDir(): Promise<void> {
  // No-op
}

// ─── Read-only mode ─────────────────────────────────────────────────────────

let cachedReadOnly: boolean | null = null;

/**
 * Whether the config namespace is locked. Operators set
 * ADMIN_CONFIG_READONLY=true after running the setup wizard and want
 * the app to refuse mutations to admin config (cleaner error than
 * letting a write fail mid-request).
 *
 * On Blob, this flag is purely advisory - Blob is always writable as
 * long as BLOB_READ_WRITE_TOKEN is valid. Operators on Vercel can leave
 * it unset.
 */
export function isConfigReadOnly(): boolean {
  if (cachedReadOnly !== null) return cachedReadOnly;
  const v = (process.env.ADMIN_CONFIG_READONLY || '').toLowerCase();
  cachedReadOnly = v === 'true' || v === '1' || v === 'yes';
  return cachedReadOnly;
}

/**
 * Probe the storage backend by writing and deleting a temporary key.
 * Used to auto-detect read-only mounts when ADMIN_CONFIG_READONLY isn't
 * set explicitly.
 */
export async function probeConfigReadOnly(): Promise<boolean> {
  if (process.env.ADMIN_CONFIG_READONLY) return isConfigReadOnly();
  try {
    const probeKey = 'admin/.rw-probe';
    const storage = getStorage();
    await storage.put(probeKey, '');
    await storage.del(probeKey);
    cachedReadOnly = false;
    return false;
  } catch {
    cachedReadOnly = true;
    logger.info('Config storage is read-only (auto-detected)');
    return true;
  }
}

export class ConfigReadOnlyError extends Error {
  constructor(operation: string) {
    super(
      `Cannot ${operation}: configuration is read-only. ` +
        `Unset ADMIN_CONFIG_READONLY or grant write access to the storage backend.`
    );
    this.name = 'ConfigReadOnlyError';
  }
}

export function assertWritable(operation: string): void {
  if (isConfigReadOnly()) throw new ConfigReadOnlyError(operation);
}

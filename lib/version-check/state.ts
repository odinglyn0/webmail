import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import type { VersionCheckStateFile } from './types';
import { DEFAULT_VERSION_ENDPOINT } from './types';

/**
 * Logical key for the version-check state JSON.
 *
 * Layout intentionally mirrors the legacy on-disk path
 * (data/version-check/state.json) so the fs backend stays drop-in
 * compatible with existing volumes. The blob backend stores the same
 * key under its configured prefix.
 *
 * The legacy VERSION_CHECK_DATA_DIR env var is no longer honored when
 * using the abstraction; configure the backend with STORAGE_BACKEND
 * instead. Operators on Docker who want to relocate this file can
 * point STORAGE_BACKEND=fs and override the storage root.
 */
const STATE_KEY = 'version-check/state.json';

const DEFAULTS: VersionCheckStateFile = {
  endpoint: DEFAULT_VERSION_ENDPOINT,
  lastCheckedAt: null,
  lastSuccessAt: null,
  nextScheduledAt: null,
  status: null,
};

/**
 * @deprecated Storage backend handles directory creation. Kept for
 * source compatibility with callers that haven't been migrated yet.
 */
export async function ensureDir(): Promise<void> {
  // No-op: storage backend creates parent dirs / namespaces on demand.
}

export async function loadState(): Promise<VersionCheckStateFile> {
  try {
    const buf = await getStorage().get(STATE_KEY);
    if (!buf) return { ...DEFAULTS };
    const parsed = JSON.parse(buf.toString('utf-8')) as Partial<VersionCheckStateFile>;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    logger.warn('version-check: state read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...DEFAULTS };
  }
}

export async function saveState(state: VersionCheckStateFile): Promise<void> {
  await getStorage().put(STATE_KEY, JSON.stringify(state, null, 2));
}

export function disabledByEnv(): boolean {
  const v = (process.env.BULWARK_UPDATE_CHECK ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return true;
  return false;
}

export function effectiveEndpoint(state: VersionCheckStateFile): string {
  // Env var wins over state file so an operator can override at runtime
  // without editing on-disk state. An explicit empty value disables the check.
  const envUrl = process.env.BULWARK_UPDATE_CHECK_URL;
  if (envUrl !== undefined) return envUrl.trim();
  return state.endpoint || DEFAULT_VERSION_ENDPOINT;
}

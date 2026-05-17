import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import {
  getConfigPath,
  getStatePath,
  isConfigReadOnly,
} from './paths';
import type { AdminConfigData, AdminStateData } from './types';

const MIGRATION_MARKER = '.migrated-v2';

interface LegacyAdminData {
  passwordHash: string;
  createdAt?: string;
  lastLogin?: string | null;
  passwordChangedAt?: string;
}

/**
 * One-shot migration from the v1 layout (everything mixed under
 * `data/admin/`) to the v2 layout (config + state split, see
 * lib/admin/paths.ts). Idempotent via a `.migrated-v2` marker.
 *
 * Migrations performed:
 *   1. admin.json with timestamps → admin.json (passwordHash only) +
 *      admin-state.json (createdAt, lastLogin, passwordChangedAt).
 *   2. audit.log copied from config namespace to state namespace.
 *
 * Skipped silently when the config namespace is read-only.
 *
 * Note: this migration only runs on the fs backend. On the blob backend
 * fresh installs start in v2 layout directly, so there's nothing to
 * migrate. We keep the function here so existing fs deployments upgrading
 * past this release still pick up the migration.
 */
export async function migrateLegacyAdminLayout(): Promise<void> {
  if (isConfigReadOnly()) return;
  // Skip on blob: fresh blob installs are always v2; there's no v1 layout
  // to migrate from on a serverless deployment.
  if ((process.env.STORAGE_BACKEND || '').toLowerCase() === 'blob') return;

  const storage = getStorage();
  const markerKey = getConfigPath(MIGRATION_MARKER);
  if (await storage.has(markerKey)) return;

  let didWork = false;

  try {
    didWork = (await migrateAdminJson()) || didWork;
    didWork = (await migrateAuditLog()) || didWork;

    await storage.put(markerKey, new Date().toISOString());
    if (didWork) {
      logger.info('Admin layout migrated to v2 (config/state split)');
    }
  } catch (error) {
    logger.warn('Admin layout migration failed; will retry on next boot', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

async function migrateAdminJson(): Promise<boolean> {
  const storage = getStorage();
  const adminKey = getConfigPath('admin.json');
  const buf = await storage.get(adminKey);
  if (!buf) return false;

  let data: LegacyAdminData;
  try {
    data = JSON.parse(buf.toString('utf-8')) as LegacyAdminData;
  } catch {
    logger.warn('admin.json is not valid JSON; skipping migration');
    return false;
  }

  const hasLegacyFields =
    'createdAt' in data || 'lastLogin' in data || 'passwordChangedAt' in data;
  if (!hasLegacyFields) return false; // already in v2 shape

  if (!data.passwordHash || typeof data.passwordHash !== 'string') {
    logger.warn('admin.json missing passwordHash; skipping migration');
    return false;
  }

  const now = new Date().toISOString();
  const stateData: AdminStateData = {
    createdAt: data.createdAt ?? now,
    lastLogin: data.lastLogin ?? null,
    passwordChangedAt: data.passwordChangedAt ?? now,
  };
  const configData: AdminConfigData = { passwordHash: data.passwordHash };

  // Don't stomp existing v2 admin-state.json (a previous migration may
  // already have run and recorded fresh timestamps).
  const stateKey = getStatePath('admin-state.json');
  if (!(await storage.has(stateKey))) {
    await storage.put(stateKey, JSON.stringify(stateData, null, 2));
  }
  await storage.put(adminKey, JSON.stringify(configData, null, 2));

  logger.info('Migrated admin.json: split timestamps into admin-state.json');
  return true;
}

async function migrateAuditLog(): Promise<boolean> {
  const storage = getStorage();
  const sources = [
    'audit.log',
    'audit.log.1',
    'audit.log.2',
    'audit.log.3',
  ];

  let moved = false;
  for (const name of sources) {
    const src = getConfigPath(name);
    if (!(await storage.has(src))) continue;

    const dst = getStatePath(name);
    const data = await storage.get(src);
    if (!data) continue;
    await storage.put(dst, data);
    await storage.del(src);
    moved = true;
  }

  if (moved) {
    logger.info('Migrated audit.log to state namespace');
  }
  return moved;
}

/**
 * Returns whether legacy data is still mixed in the config namespace
 * (for diagnostics / admin UI).
 */
export async function getLegacyDataInfo(): Promise<{ adminJsonHasTimestamps: boolean; auditLogInConfigDir: boolean }> {
  const storage = getStorage();

  let adminJsonHasTimestamps = false;
  const adminJsonBuf = await storage.get(getConfigPath('admin.json')).catch(() => null);
  if (adminJsonBuf) {
    try {
      const parsed = JSON.parse(adminJsonBuf.toString('utf-8'));
      adminJsonHasTimestamps =
        'createdAt' in parsed ||
        'lastLogin' in parsed ||
        'passwordChangedAt' in parsed;
    } catch {
      /* ignore */
    }
  }

  const auditLogInConfigDir = await storage.has(getConfigPath('audit.log'));

  return { adminJsonHasTimestamps, auditLogInConfigDir };
}

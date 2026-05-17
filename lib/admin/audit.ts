import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import { getStatePath } from './paths';
import type { AuditEntry } from './types';

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATIONS = 3;
const AUDIT_LOG_FILE = 'audit.log';

function auditLogKey(rotation = 0): string {
  return rotation === 0
    ? getStatePath(AUDIT_LOG_FILE)
    : getStatePath(`${AUDIT_LOG_FILE}.${rotation}`);
}

/**
 * Append an audit entry to the admin audit log. Stored under the state
 * namespace so it remains writable when the config namespace is mounted
 * read-only.
 *
 * Atomicity: the storage backend serializes appends to the same key
 * within a single process. Concurrent appends from different instances
 * (e.g. multiple Vercel function instances under load) can still race;
 * this matches the upstream behavior on multi-container Docker
 * deployments without an external lock and is acceptable for an admin
 * audit log where events are infrequent.
 */
export async function auditLog(action: string, detail: Record<string, unknown>, ip: string): Promise<void> {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    action,
    detail,
    ip,
  };

  const key = auditLogKey();
  try {
    await getStorage().appendLine(key, JSON.stringify(entry));
    await rotateIfNeeded(key);
  } catch (error) {
    logger.error('Failed to write audit log', { error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

async function rotateIfNeeded(key: string): Promise<void> {
  try {
    const storage = getStorage();
    const size = await storage.size(key);
    if (size < 0 || size < MAX_LOG_SIZE) return;

    // Rotate from oldest to newest:
    //   audit.log.<MAX> is dropped, audit.log.<n> -> audit.log.<n+1>,
    //   audit.log -> audit.log.1
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const from = i === 1 ? key : auditLogKey(i - 1);
      const to = auditLogKey(i);
      try {
        const buf = await storage.get(from);
        if (!buf) continue;
        await storage.put(to, buf);
        await storage.del(from);
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Read audit log entries, newest first. Supports pagination.
 */
export async function readAuditLog(page: number = 1, limit: number = 50, actionFilter?: string): Promise<{ entries: AuditEntry[]; total: number }> {
  const key = auditLogKey();
  try {
    const buf = await getStorage().get(key);
    if (!buf) return { entries: [], total: 0 };
    const content = buf.toString('utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    let entries: AuditEntry[] = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((e): e is AuditEntry => e !== null);

    if (actionFilter) {
      entries = entries.filter(e => e.action === actionFilter);
    }

    const total = entries.length;
    entries.reverse();
    const start = (page - 1) * limit;
    return { entries: entries.slice(start, start + limit), total };
  } catch (error) {
    logger.warn('Failed to read audit log', { error: error instanceof Error ? error.message : 'Unknown error' });
    return { entries: [], total: 0 };
  }
}

import path from 'node:path';
import { logger } from '@/lib/logger';
import { FsBackend } from './fs-backend';
import { BlobBackend } from './blob-backend';
import type { BackendName, StorageBackend } from './types';

export type { StorageBackend } from './types';

function resolveBackend(): BackendName {
  const v = (process.env.STORAGE_BACKEND || '').toLowerCase().trim();
  if (v === 'blob') return 'blob';
  if (v === 'fs' || v === '') return 'fs';
  throw new Error(`Invalid STORAGE_BACKEND: ${v} (expected 'fs' or 'blob')`);
}

let cached: StorageBackend | null = null;

/**
 * Get the configured storage backend. Singleton; backend selection is
 * fixed for the process lifetime.
 *
 * Backend selection:
 *   STORAGE_BACKEND=fs   (default) - disk under <cwd>/data, or wherever
 *                                    the various *_DATA_DIR vars point.
 *                                    Subdirectories are created on demand.
 *   STORAGE_BACKEND=blob           - Vercel Blob. Requires
 *                                    BLOB_READ_WRITE_TOKEN. Optional
 *                                    STORAGE_BLOB_PREFIX namespaces
 *                                    multiple deployments in one store.
 */
export function getStorage(): StorageBackend {
  if (cached) return cached;

  const backend = resolveBackend();
  if (backend === 'blob') {
    const prefix = (process.env.STORAGE_BLOB_PREFIX || 'bulwark').replace(/^\/+|\/+$/g, '');
    logger.info('Storage backend: blob', { prefix });
    cached = new BlobBackend(prefix);
  } else {
    // For the fs backend, the storage root is <cwd>/data. Each module
    // composes keys under that root (e.g. 'admin/config.json'). The
    // legacy *_DATA_DIR env vars are still respected by the modules
    // themselves when they compose keys (see admin/paths.ts etc.).
    const root = path.resolve(process.cwd(), 'data');
    logger.info('Storage backend: fs', { root });
    cached = new FsBackend(root);
  }
  return cached;
}

/** Test-only: reset the singleton. */
export function _resetStorageForTests(): void {
  cached = null;
}

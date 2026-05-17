import { put, del, head, list, get } from '@vercel/blob';
import type { StorageBackend } from './types';
import { logger } from '@/lib/logger';

/**
 * Vercel Blob-backed storage. REQUIRES a private Blob store (created
 * with access:'private' in the Vercel dashboard, or `vercel blob
 * create-store --access private` via the CLI).
 *
 * Why private: this app stores password hashes, encrypted session blobs,
 * setup tokens, and per-user encrypted settings. Public Blob URLs are
 * unguessable in practice (random suffix) but become predictable when
 * we use addRandomSuffix=false (which we must, to address objects by
 * key). Private storage requires the BLOB_READ_WRITE_TOKEN for every
 * read, so leaking a URL doesn't leak the contents.
 *
 * Differences from FsBackend semantics:
 *  - put() is atomic at the request level: each PUT replaces the object
 *    in one operation. Readers see either the old or the new value, never
 *    a partial write. No tmp+rename needed.
 *  - list() is eventually consistent on Blob. We never use list() on a
 *    code path where freshness matters; registries are stored as single
 *    JSON files and read via get() which is strongly consistent.
 *  - appendLine() is read-modify-write under an in-process mutex per key.
 *    Concurrent appends from *different* function instances can still
 *    interleave; this is a known limitation that matches the fs backend's
 *    behavior across multiple Docker containers without an external lock.
 *
 * Required env:
 *   BLOB_READ_WRITE_TOKEN  - set automatically by Vercel when a private
 *                            Blob store is connected to the project.
 *
 * Optional env:
 *   STORAGE_BLOB_PREFIX    - namespace prefix so multiple deployments
 *                            (prod, staging) can share a single store.
 *                            Defaults to 'bulwark'.
 */
export class BlobBackend implements StorageBackend {
  private readonly mutexes = new Map<string, Promise<unknown>>();

  constructor(private readonly prefix: string) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      logger.warn('BlobBackend: BLOB_READ_WRITE_TOKEN is not set. Blob operations will fail.');
    }
  }

  private fullKey(key: string): string {
    if (key.startsWith('/')) key = key.slice(1);
    if (key.includes('..')) throw new Error(`Invalid storage key: ${key}`);
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private stripPrefix(fullKey: string): string {
    if (this.prefix && fullKey.startsWith(this.prefix + '/')) {
      return fullKey.slice(this.prefix.length + 1);
    }
    return fullKey;
  }

  /**
   * Serialize operations on a single key in this process. Used by
   * appendLine and any other read-modify-write caller.
   */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutexes.set(key, next);
    try {
      return (await next) as T;
    } finally {
      // Cleanup if no other waiters arrived in the meantime.
      if (this.mutexes.get(key) === next) this.mutexes.delete(key);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const full = this.fullKey(key);
    try {
      const result = await get(full, { access: 'private' });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const reader = result.stream.getReader();
      const chunks: Buffer[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('NotFound') || msg.includes('404')) return null;
      throw err;
    }
  }

  async put(key: string, value: Buffer | string): Promise<void> {
    const full = this.fullKey(key);
    const body = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value;
    await put(full, body, {
      access: 'private',
      // Replace the existing object instead of suffixing a random hash.
      // Required so we can address objects by deterministic key.
      addRandomSuffix: false,
      allowOverwrite: true,
      // Disable the CDN cache for app-state objects; freshness matters.
      cacheControlMaxAge: 0,
      contentType: 'application/octet-stream',
    });
  }

  async del(key: string): Promise<void> {
    const full = this.fullKey(key);
    try {
      await del(full);
    } catch (err) {
      // del() is idempotent in the SDK; swallow not-found errors anyway.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found') || msg.includes('404')) return;
      throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    const full = this.fullKey(key);
    try {
      const meta = await head(full);
      return !!meta;
    } catch {
      return false;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.fullKey(prefix);
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: fullPrefix, cursor, limit: 1000 });
      for (const blob of page.blobs) {
        out.push(this.stripPrefix(blob.pathname));
      }
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  async appendLine(key: string, line: string): Promise<void> {
    const text = line.endsWith('\n') ? line : line + '\n';
    await this.withLock(key, async () => {
      const existing = await this.get(key);
      const next = existing ? Buffer.concat([existing, Buffer.from(text, 'utf-8')]) : Buffer.from(text, 'utf-8');
      await this.put(key, next);
    });
  }

  async size(key: string): Promise<number> {
    const full = this.fullKey(key);
    try {
      const meta = await head(full);
      return meta?.size ?? -1;
    } catch {
      return -1;
    }
  }
}

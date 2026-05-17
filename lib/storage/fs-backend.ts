import { readFile, writeFile, unlink, rename, mkdir, appendFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { StorageBackend } from './types';

/**
 * Disk-backed storage. Maps logical keys to files under a configurable
 * root. This preserves the original on-disk behavior for Docker / VPS
 * deployments.
 *
 * Atomicity: writes go to <key>.tmp then rename, which is atomic on
 * POSIX same-filesystem renames (the only kind we do here).
 */
export class FsBackend implements StorageBackend {
  constructor(private readonly root: string) {}

  private fullPath(key: string): string {
    // Reject path traversal attempts. Keys are always slash-delimited and
    // should never contain '..' segments.
    const normalized = path.posix.normalize(key);
    if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') {
      throw new Error(`Invalid storage key: ${key}`);
    }
    const target = path.join(this.root, normalized);
    const resolvedRoot = path.resolve(this.root);
    const resolvedTarget = path.resolve(target);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return resolvedTarget;
  }

  private async ensureDir(filePath: string): Promise<void> {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.fullPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, value: Buffer | string): Promise<void> {
    const target = this.fullPath(key);
    await this.ensureDir(target);
    const tmp = target + '.tmp';
    await writeFile(tmp, value);
    await rename(tmp, target);
  }

  async del(key: string): Promise<void> {
    try {
      await unlink(this.fullPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.fullPath(key));
  }

  async list(prefix: string): Promise<string[]> {
    const root = this.fullPath(prefix);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile() && !entry.name.endsWith('.tmp')) {
          // Convert filesystem path back to a logical key.
          const rel = path.relative(this.root, full).split(path.sep).join('/');
          out.push(rel);
        }
      }
    }
    return out;
  }

  async appendLine(key: string, line: string): Promise<void> {
    const target = this.fullPath(key);
    await this.ensureDir(target);
    await appendFile(target, line.endsWith('\n') ? line : line + '\n', 'utf-8');
  }

  async size(key: string): Promise<number> {
    try {
      const s = await stat(this.fullPath(key));
      return s.size;
    } catch {
      return -1;
    }
  }
}

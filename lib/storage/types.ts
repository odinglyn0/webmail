// Storage backend abstraction.
//
// Two backends are supported:
//   - 'fs' (default): Node fs/promises against a real disk. Used for
//     Docker, bare-metal, and any deployment with a persistent volume.
//   - 'blob': Vercel Blob. Used for Vercel deployments where there is no
//     persistent local filesystem outside /tmp.
//
// Selection is via STORAGE_BACKEND env var. The fs backend preserves
// 100% of the original on-disk behavior; the blob backend stores the
// same logical key/value pairs but in Blob with a consistent prefix.
//
// Keys are slash-delimited and SHOULD NOT start with a leading slash:
//   admin/config.json, admin/state/admin-state.json, admin/plugins/<id>.js
//
// All values are stored as Buffer; callers are responsible for encoding
// (JSON, encrypted bytes, raw text). The abstraction does not interpret.

export interface StorageBackend {
  /** Return the value for a key, or null if it doesn't exist. */
  get(key: string): Promise<Buffer | null>;

  /**
   * Write a value atomically. Implementations should make this atomic
   * with respect to concurrent reads (i.e. readers see either the old
   * value or the new value, never a partial write).
   */
  put(key: string, value: Buffer | string): Promise<void>;

  /** Delete a key. No-op if it doesn't exist. */
  del(key: string): Promise<void>;

  /** True if the key exists. */
  has(key: string): Promise<boolean>;

  /**
   * List keys under a prefix. The prefix is a slash-delimited path; the
   * returned keys are full keys (not relative to the prefix). Order is
   * not guaranteed.
   */
  list(prefix: string): Promise<string[]>;

  /**
   * Append a line of text to a key. Used by the audit log. Implementations
   * may use real append semantics (fs) or read-modify-write under a per-key
   * mutex (blob).
   */
  appendLine(key: string, line: string): Promise<void>;

  /** Best-effort size in bytes; -1 if unknown. */
  size(key: string): Promise<number>;
}

export type BackendName = 'fs' | 'blob';

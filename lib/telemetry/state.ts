import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import type { TelemetryStateFile, ConsentState } from './types';
import { DEFAULT_ENDPOINT } from './types';

const STATE_KEY = 'telemetry/state.json';
const ID_KEY = 'telemetry/.telemetry-id';

function envOverride(): ConsentState | null {
  const v = (process.env.BULWARK_TELEMETRY ?? '').toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'off';
  if (process.env.BULWARK_TELEMETRY_DISABLED) {
    const d = process.env.BULWARK_TELEMETRY_DISABLED.toLowerCase();
    if (d === '1' || d === 'true' || d === 'yes') return 'off';
  }
  return null;
}

/** @deprecated Storage backend handles namespace creation. */
export async function ensureDir(): Promise<void> {
  // No-op
}

export async function getInstanceId(): Promise<string> {
  const storage = getStorage();
  try {
    const buf = await storage.get(ID_KEY);
    if (buf) {
      const id = buf.toString('utf-8').trim();
      if (/^[0-9a-f-]{36}$/i.test(id)) return id;
    }
  } catch { /* generate fresh */ }
  const fresh = randomUUID();
  await storage.put(ID_KEY, fresh);
  return fresh;
}

// Default consent is 'on' - telemetry is anonymous and enabled by default.
// Admins can disable via the UI, the BULWARK_TELEMETRY env var, or by clearing
// the endpoint. See https://bulwarkmail.org/docs/legal/privacy/telemetry.
const DEFAULTS: TelemetryStateFile = {
  consent: 'on',
  endpoint: DEFAULT_ENDPOINT,
  consentedAt: null,
  lastSentAt: null,
  nextScheduledAt: null,
};

export async function loadState(): Promise<TelemetryStateFile> {
  const storage = getStorage();
  try {
    const buf = await storage.get(STATE_KEY);
    if (buf) {
      const parsed = JSON.parse(buf.toString('utf-8')) as Partial<TelemetryStateFile>;
      return { ...DEFAULTS, ...parsed };
    }
  } catch (err) {
    logger.warn('telemetry: state read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // First-ever load: persist the default-on state with a consentedAt
  // stamp so the admin UI can show "telemetry was auto-enabled at <time>"
  // without re-arming on restart.
  const fresh: TelemetryStateFile = {
    ...DEFAULTS,
    consentedAt: new Date().toISOString(),
  };
  try {
    await saveState(fresh);
  } catch (err) {
    // Read-only or transient storage error: still return the in-memory
    // default so callers can proceed; we'll retry persisting next call.
    logger.warn('telemetry: failed to persist default state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return fresh;
}

export async function saveState(state: TelemetryStateFile): Promise<void> {
  await getStorage().put(STATE_KEY, JSON.stringify(state, null, 2));
}

// Effective consent: env var wins over file. UI changes are blocked
// when env override is active so the user knows where it's coming from.
export async function effectiveConsent(): Promise<{
  consent: ConsentState;
  source: 'env' | 'file';
  state: TelemetryStateFile;
}> {
  const envState = envOverride();
  const state = await loadState();
  if (envState) return { consent: envState, source: 'env', state };
  return { consent: state.consent, source: 'file', state };
}

export function endpointEnabled(endpoint: string | undefined): boolean {
  return !!endpoint && endpoint.trim().length > 0;
}

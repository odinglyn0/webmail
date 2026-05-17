import { configManager } from '@/lib/admin/config-manager';
import { isConfigReadOnly } from '@/lib/admin/paths';
import { getStorage } from '@/lib/storage';
import { getConfigPath } from '@/lib/admin/paths';

/**
 * The three lifecycle states for the running container.
 *
 *   bootstrap    - no config persisted yet and no JMAP_SERVER_URL env. The
 *                  setup wizard is served at /setup; everything else 302s
 *                  there.
 *   configured   - setup wizard finished (admin override config.json carries
 *                  setupComplete=true). Normal app; /setup returns 404.
 *   env-managed  - JMAP_SERVER_URL is set in the environment, so the
 *                  operator is configuring via .env (legacy / CI path). The
 *                  wizard stays disabled.
 */
export type SetupState = 'bootstrap' | 'configured' | 'env-managed';

/**
 * Cheap to call on every request. configManager keeps `setupComplete` in
 * memory after the initial load, so this is just env reads + an in-memory
 * boolean check.
 */
export function detectSetupState(): SetupState {
  if (configManager.isSetupComplete()) return 'configured';
  if (process.env.JMAP_SERVER_URL && process.env.JMAP_SERVER_URL.trim() !== '') {
    return 'env-managed';
  }
  // Read-only config + no setupComplete flag means the operator locked
  // before the wizard ran. Fall through to bootstrap so the failure
  // (write attempt during wizard) surfaces with a clear error rather
  // than silently 404'ing /setup.
  if (isConfigReadOnly()) return 'bootstrap';
  return 'bootstrap';
}

/**
 * Whether the wizard's UI and APIs should be reachable.
 */
export function isSetupActive(): boolean {
  return detectSetupState() === 'bootstrap';
}

/**
 * The persisted `.config-locked` marker the wizard drops when the operator
 * checks "lock configuration after setup" on the review screen. Purely
 * advisory - the actual locking is the operator's `:ro` mount or the
 * ADMIN_CONFIG_READONLY env var. This object's presence is what the admin
 * UI uses to remind the operator that they intended to lock.
 */
export async function lockMarkerExists(): Promise<boolean> {
  return getStorage().has(getConfigPath('.config-locked'));
}

import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import { assertWritable } from './paths';

function configKey(pluginId: string): string {
  // Reject anything other than the documented plugin-id alphabet so we
  // can't be coerced into writing outside the namespace.
  if (!/^[a-z0-9._-]+$/i.test(pluginId)) {
    throw new Error(`Invalid plugin id: ${pluginId}`);
  }
  return `admin/plugin-config/${pluginId}.json`;
}

/**
 * Get all config for a plugin.
 */
export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  try {
    const buf = await getStorage().get(configKey(pluginId));
    if (!buf) return {};
    return JSON.parse(buf.toString('utf-8'));
  } catch (error) {
    logger.warn(`Failed to read plugin config for ${pluginId}`, {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
}

/**
 * Set a single config key for a plugin.
 */
export async function setPluginConfig(pluginId: string, key: string, value: unknown): Promise<void> {
  assertWritable('update plugin config');
  const config = await getPluginConfig(pluginId);
  config[key] = value;
  await getStorage().put(configKey(pluginId), JSON.stringify(config, null, 2));
}

/**
 * Delete a single config key for a plugin.
 */
export async function deletePluginConfigKey(pluginId: string, key: string): Promise<void> {
  assertWritable('delete plugin config key');
  const config = await getPluginConfig(pluginId);
  delete config[key];

  if (Object.keys(config).length === 0) {
    await getStorage().del(configKey(pluginId));
    return;
  }

  await getStorage().put(configKey(pluginId), JSON.stringify(config, null, 2));
}

/**
 * Delete all config for a plugin (used when uninstalling).
 */
export async function deleteAllPluginConfig(pluginId: string): Promise<void> {
  assertWritable('delete plugin config');
  await getStorage().del(configKey(pluginId));
}

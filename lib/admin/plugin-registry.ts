import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger';
import { getStorage } from '@/lib/storage';
import { assertWritable } from './paths';

const PLUGIN_REGISTRY_KEY = 'admin/plugins/registry.json';
const THEME_REGISTRY_KEY = 'admin/themes/registry.json';

function pluginBundleKey(id: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`Invalid plugin id: ${id}`);
  return `admin/plugins/${id}.js`;
}

function themeCssKey(id: string): string {
  if (!/^[a-z0-9._-]+$/i.test(id)) throw new Error(`Invalid theme id: ${id}`);
  return `admin/themes/${id}.css`;
}

// ─── Types ───────────────────────────────────────────────────

export interface PluginConfigField {
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  options?: { label: string; value: string }[];
}

/**
 * Per-user setting field, mirrors the manifest's `settingsSchema` shape
 * (see lib/plugin-types.ts SettingFieldSchema). The server passes these
 * through unchanged so the client can render the per-user settings UI.
 */
export interface PluginSettingsField {
  type: 'boolean' | 'string' | 'number' | 'select';
  label: string;
  description?: string;
  default: unknown;
  options?: string[];
  min?: number;
  max?: number;
}

export interface ServerPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: string;
  permissions: string[];
  entrypoint: string;
  enabled: boolean;
  forceEnabled?: boolean;
  configSchema?: Record<string, PluginConfigField>;
  settingsSchema?: Record<string, PluginSettingsField>;
  installedAt: string;
  updatedAt: string;
  /**
   * SHA-256 hex of the bundle code (first 16 chars). Refreshed every save so
   * the same version re-uploaded with new code still appears as a change to
   * the client. Also doubles as the HTTP ETag for the bundle endpoint.
   */
  bundleHash?: string;
  /**
   * Validated CSP origins (https-only, single-origin form) the plugin may
   * embed. Merged into the host frame-src by the proxy.
   */
  frameOrigins?: string[];
  /**
   * Validated HTTPS origins the plugin may target via `api.http.fetch()`.
   * Same syntax as `frameOrigins`. Surfaced to clients via /api/plugins.
   */
  httpOrigins?: string[];
}

export interface ServerTheme {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  variants: string[];
  enabled: boolean;
  forceEnabled?: boolean;
  installedAt: string;
  updatedAt: string;
}

interface PluginRegistry {
  plugins: ServerPlugin[];
}

interface ThemeRegistry {
  themes: ServerTheme[];
}

// ─── Helpers ─────────────────────────────────────────────────

async function readJsonKey<T>(key: string, fallback: T): Promise<T> {
  try {
    const buf = await getStorage().get(key);
    if (!buf) return fallback;
    return JSON.parse(buf.toString('utf-8'));
  } catch (error) {
    logger.warn(`Failed to read ${key}`, { error: error instanceof Error ? error.message : 'Unknown error' });
    return fallback;
  }
}

async function writeJsonKey(key: string, data: unknown): Promise<void> {
  await getStorage().put(key, JSON.stringify(data, null, 2));
}

// ─── Plugin Operations ───────────────────────────────────────

export async function getPluginRegistry(): Promise<PluginRegistry> {
  return readJsonKey<PluginRegistry>(PLUGIN_REGISTRY_KEY, { plugins: [] });
}

export async function getPlugin(id: string): Promise<ServerPlugin | null> {
  const registry = await getPluginRegistry();
  return registry.plugins.find(p => p.id === id) || null;
}

export async function savePlugin(
  plugin: ServerPlugin,
  code: string,
): Promise<void> {
  assertWritable('install plugin');
  const storage = getStorage();

  // Save code bundle
  await storage.put(pluginBundleKey(plugin.id), code);

  // Stamp content hash + updatedAt so clients can detect re-uploads even
  // when the manifest version hasn't changed. Preserve the original
  // installedAt across re-uploads.
  const bundleHash = createHash('sha256').update(code).digest('hex').slice(0, 16);
  const now = new Date().toISOString();

  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === plugin.id);
  const next: ServerPlugin = {
    ...plugin,
    bundleHash,
    updatedAt: now,
    installedAt: idx >= 0 ? registry.plugins[idx].installedAt : plugin.installedAt,
  };
  if (idx >= 0) {
    registry.plugins[idx] = next;
  } else {
    registry.plugins.push(next);
  }
  await writeJsonKey(PLUGIN_REGISTRY_KEY, registry);
}

export async function updatePluginMeta(id: string, updates: Partial<Pick<ServerPlugin, 'enabled' | 'forceEnabled'>>): Promise<ServerPlugin | null> {
  assertWritable('update plugin metadata');
  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === id);
  if (idx < 0) return null;

  registry.plugins[idx] = { ...registry.plugins[idx], ...updates, updatedAt: new Date().toISOString() };
  await writeJsonKey(PLUGIN_REGISTRY_KEY, registry);
  return registry.plugins[idx];
}

export async function deletePlugin(id: string): Promise<boolean> {
  assertWritable('delete plugin');
  const registry = await getPluginRegistry();
  const idx = registry.plugins.findIndex(p => p.id === id);
  if (idx < 0) return false;

  registry.plugins.splice(idx, 1);
  await writeJsonKey(PLUGIN_REGISTRY_KEY, registry);

  // Remove bundle
  try { await getStorage().del(pluginBundleKey(id)); } catch { /* ok if missing */ }

  return true;
}

export async function getPluginBundle(id: string): Promise<string | null> {
  try {
    const buf = await getStorage().get(pluginBundleKey(id));
    return buf ? buf.toString('utf-8') : null;
  } catch {
    return null;
  }
}

// ─── Theme Operations ────────────────────────────────────────

export async function getThemeRegistry(): Promise<ThemeRegistry> {
  return readJsonKey<ThemeRegistry>(THEME_REGISTRY_KEY, { themes: [] });
}

export async function getTheme(id: string): Promise<ServerTheme | null> {
  const registry = await getThemeRegistry();
  return registry.themes.find(t => t.id === id) || null;
}

export async function saveTheme(
  theme: ServerTheme,
  css: string,
): Promise<void> {
  assertWritable('install theme');
  const storage = getStorage();

  // Save CSS
  await storage.put(themeCssKey(theme.id), css);

  // Update registry
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === theme.id);
  if (idx >= 0) {
    registry.themes[idx] = theme;
  } else {
    registry.themes.push(theme);
  }
  await writeJsonKey(THEME_REGISTRY_KEY, registry);
}

export async function updateThemeMeta(id: string, updates: Partial<Pick<ServerTheme, 'enabled' | 'forceEnabled'>>): Promise<ServerTheme | null> {
  assertWritable('update theme metadata');
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === id);
  if (idx < 0) return null;

  registry.themes[idx] = { ...registry.themes[idx], ...updates, updatedAt: new Date().toISOString() };
  await writeJsonKey(THEME_REGISTRY_KEY, registry);
  return registry.themes[idx];
}

export async function deleteTheme(id: string): Promise<boolean> {
  assertWritable('delete theme');
  const registry = await getThemeRegistry();
  const idx = registry.themes.findIndex(t => t.id === id);
  if (idx < 0) return false;

  registry.themes.splice(idx, 1);
  await writeJsonKey(THEME_REGISTRY_KEY, registry);

  try { await getStorage().del(themeCssKey(id)); } catch { /* ok if missing */ }

  return true;
}

export async function getThemeCSS(id: string): Promise<string | null> {
  try {
    const buf = await getStorage().get(themeCssKey(id));
    return buf ? buf.toString('utf-8') : null;
  } catch {
    return null;
  }
}

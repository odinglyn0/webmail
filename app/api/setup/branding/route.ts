import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { detectSetupState } from '@/lib/setup/state';
import { authenticateWizardRequest } from '@/lib/setup/session';
import { configManager } from '@/lib/admin/config-manager';
import { getConfigPath, assertWritable } from '@/lib/admin/paths';
import { getStorage } from '@/lib/storage';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

const ALLOWED_MIME_TYPES = new Set([
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

const VALID_SLOTS = new Set([
  'faviconUrl',
  'appLogoLightUrl',
  'appLogoDarkUrl',
  'loginLogoLightUrl',
  'loginLogoDarkUrl',
]);

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': '.svg',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

function brandingKey(filename: string): string {
  return getConfigPath(`branding/${filename}`);
}

function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * POST /api/setup/branding - wizard branding upload.
 *
 * Multipart form fields:
 *   file - the image (SVG/PNG/JPEG/WebP/ICO, max 2 MB)
 *   slot - which branding key (faviconUrl, loginLogoLightUrl, etc.)
 *
 * Mirrors /api/admin/branding but authenticates via the wizard cookie
 * instead of admin session - admin auth doesn't exist yet during bootstrap.
 * The public read endpoint at /api/admin/branding/<filename> serves both
 * wizard- and admin-uploaded assets after setup.
 */
export async function POST(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  if (!(await authenticateWizardRequest())) {
    return NextResponse.json({ error: 'Wizard session required' }, { status: 401 });
  }

  try {
    assertWritable('upload branding asset');

    const formData = await request.formData();
    const file = formData.get('file');
    const slot = formData.get('slot');

    if (!(file instanceof File) || typeof slot !== 'string') {
      return NextResponse.json({ error: 'Missing file or slot' }, { status: 400 });
    }
    if (!VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: `Invalid slot: ${slot}` }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File too large (max 2 MB)' }, { status: 400 });
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${file.type}. Allowed: SVG, PNG, JPEG, WebP, ICO` },
        { status: 400 },
      );
    }

    const ext = EXT_BY_MIME[file.type] ?? '.png';
    const safeName = sanitizeFilename(`${slot}${ext}`);
    const storage = getStorage();

    // Remove any existing object for this slot with a different extension
    // so the wizard doesn't leave orphans behind on re-upload.
    for (const otherExt of Object.values(EXT_BY_MIME)) {
      if (otherExt === ext) continue;
      const oldKey = brandingKey(`${slot}${otherExt}`);
      if (await storage.has(oldKey)) {
        try { await storage.del(oldKey); } catch { /* ignore */ }
      }
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    await storage.put(brandingKey(safeName), buffer);

    const servedUrl = `/api/admin/branding/${safeName}`;
    await configManager.ensureLoaded();
    await configManager.setAdminConfig({ [slot]: servedUrl });

    return NextResponse.json({ url: servedUrl, filename: safeName });
  } catch (error) {
    logger.error('Wizard branding upload failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

/**
 * DELETE /api/setup/branding - remove an uploaded asset and clear the
 * config override so the slot falls back to the system default.
 *
 * Body: { slot: string }
 */
export async function DELETE(request: NextRequest) {
  if (detectSetupState() !== 'bootstrap') {
    return NextResponse.json({ error: 'Setup is not active' }, { status: 404 });
  }
  if (!(await authenticateWizardRequest())) {
    return NextResponse.json({ error: 'Wizard session required' }, { status: 401 });
  }

  try {
    assertWritable('remove branding asset');
    const { slot } = (await request.json()) as { slot?: string };
    if (!slot || !VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: 'Invalid or missing slot' }, { status: 400 });
    }

    const storage = getStorage();
    for (const ext of Object.values(EXT_BY_MIME)) {
      const key = brandingKey(`${slot}${ext}`);
      if (await storage.has(key)) {
        try { await storage.del(key); } catch { /* ignore */ }
      }
    }

    await configManager.ensureLoaded();
    await configManager.removeAdminOverride(slot);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error('Wizard branding delete failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import { getStorage } from '@/lib/storage';
import { getConfigPath } from '@/lib/admin/paths';

function brandingKey(filename: string): string {
  return getConfigPath(`branding/${filename}`);
}

const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * GET /api/admin/branding/[filename] - Serve uploaded branding images
 *
 * This endpoint is public (no admin auth) so browsers can load images.
 * Only files in the branding namespace are served; any kind of path
 * traversal is rejected.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ filename: string }> },
) {
  try {
    const { filename } = await params;

    // Sanitize: only allow basename, no path separators
    const safe = path.basename(filename);
    if (safe !== filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    const ext = path.extname(safe).toLowerCase();
    const contentType = MIME_TYPES[ext];
    if (!contentType) {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
    }

    const buffer = await getStorage().get(brandingKey(safe));
    if (!buffer) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    // Node Buffer is structurally a Uint8Array but NextResponse's BodyInit
    // typing on this Next version doesn't accept it directly; copy into a
    // fresh ArrayBuffer-backed Uint8Array and wrap as a Blob to satisfy
    // the Web Fetch contract.
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    const body = new Blob([bytes], { type: contentType });

    // SVG can carry inline <script> and event handlers that execute when the
    // file is fetched as a top-level document. Defense in depth on top of
    // admin-only upload: nosniff blocks MIME confusion, the CSP forces a
    // sandboxed unique origin so any script in an SVG is inert and cannot
    // touch app cookies or storage.
    return new NextResponse(body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600, must-revalidate',
        'Content-Length': String(buffer.length),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
}

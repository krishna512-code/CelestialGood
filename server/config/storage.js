import multer from 'multer';
import { randomUUID } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { supabase, SUPABASE_URL, SUPABASE_SERVICE_KEY } from './supabase.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Supabase Storage is used when a service_role key is present (needed because
// storage uploads require elevated privileges once RLS is on). Otherwise files
// land on local disk under UPLOADS_DIR — the classic behaviour for local dev.
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';
export const USE_SUPABASE_STORAGE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// UPLOADS_DIR: point at a persistent volume in production (e.g. /data/uploads).
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, '..', '..', 'public', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });
export { UPLOADS_DIR };

// Memory storage: files are buffered so we can forward them to Supabase Storage.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

function safeName(originalname) {
  const clean = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${Date.now()}-${randomUUID().slice(0, 8)}-${clean}`;
}

/**
 * Persist an uploaded file and return its public URL.
 * Supabase Storage when configured; local /uploads otherwise.
 * The bucket itself is created (public) by scripts/migrate-pg.mjs.
 */
export async function saveUpload(file) {
  if (!file) return '';

  if (USE_SUPABASE_STORAGE) {
    const objectPath = safeName(file.originalname);
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
    return data.publicUrl;
  }

  const filename = safeName(file.originalname);
  writeFileSync(join(UPLOADS_DIR, filename), file.buffer);
  return `/uploads/${filename}`;
}

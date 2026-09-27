import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { pool, fail, gate, userDto } from '../../db.js';
import { body, currentUser, params, parse, uuid } from '../../core/http.js';
import { decodeHeic, isHeic } from './heic.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 128_000_000;
const MAX_ENCODED = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_CONVERSIONS = 2;
const MAX_WAITING = 4;
const cropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    zoom: z.number().min(1).max(5),
  })
  .strict();
type Crop = z.infer<typeof cropSchema>;
const previewUpload = z.object({ imageBase64: z.string().min(1).max(MAX_ENCODED) }).strict();
const upload = previewUpload.extend({ crop: cropSchema.optional() }).strict();

let activeConversions = 0;
const waitingConversions: Array<(release: () => void) => void> = [];
function releaseConversion() {
  const next = waitingConversions.shift();
  if (next) next(releaseConversion);
  else activeConversions--;
}

export async function withAvatarConversionSlot<T>(convert: () => Promise<T>): Promise<T> {
  let release: () => void;
  if (activeConversions < MAX_CONVERSIONS) {
    activeConversions++;
    release = releaseConversion;
  } else {
    if (waitingConversions.length >= MAX_WAITING)
      fail('IMAGE_BUSY', 'Обработка фото занята. Повторите попытку чуть позже', 503);
    release = await new Promise<() => void>((resolve) => waitingConversions.push(resolve));
  }
  try {
    return await convert();
  } finally {
    release();
  }
}

async function prepareImage(encoded: string) {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  let valid = encoded.length > 0 && encoded.length % 4 === 0;
  for (let i = 0; valid && i < encoded.length - padding; i++) {
    const code = encoded.charCodeAt(i);
    if (!(
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    ))
      valid = false;
  }
  if (!valid) fail('INVALID_IMAGE', 'Не удалось прочитать фото. Выберите файл изображения', 400);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_BYTES)
    fail('IMAGE_TOO_LARGE', 'Фото слишком большое. Выберите файл до 25 МБ', 413);
  if (
    !bytes.length ||
    encoded.slice(-4) !== bytes.subarray(-(bytes.length % 3 || 3)).toString('base64')
  )
    fail('INVALID_IMAGE', 'Не удалось прочитать фото. Выберите файл изображения', 400);
  try {
    if (isHeic(bytes)) {
      const decoded = await decodeHeic(bytes, MAX_PIXELS);
      return {
        width: decoded.width,
        height: decoded.height,
        image: sharp(decoded.data, {
          raw: { width: decoded.width, height: decoded.height, channels: 4 },
          limitInputPixels: MAX_PIXELS,
        }),
      };
    }
    const input = { limitInputPixels: MAX_PIXELS, failOn: 'error' as const, page: 0, pages: 1 };
    const info = await sharp(bytes, input).metadata();
    if (
      !['png', 'jpeg', 'webp', 'heif', 'gif', 'tiff'].includes(info.format || '') ||
      !info.width ||
      !info.height ||
      info.width * info.height > MAX_PIXELS
    )
      fail('INVALID_IMAGE', 'Не удалось обработать это фото. Выберите другое изображение', 400);
    const swapped = [5, 6, 7, 8].includes(info.orientation || 1);
    return {
      width: swapped ? info.height : info.width,
      height: swapped ? info.width : info.height,
      image: sharp(bytes, input).autoOrient(),
    };
  } catch (error) {
    if ((error as any)?.apiCode) throw error;
    return fail(
      'INVALID_IMAGE',
      'Не удалось обработать это фото. Выберите другое изображение',
      400,
    );
  }
}

async function renderImage(encoded: string, crop?: Crop, preview = false) {
  try {
    const { image, width, height } = await prepareImage(encoded);
    if (preview) {
      const data = await image
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
      return { data, width, height };
    }
    const region = crop ?? { x: 0.5, y: 0.5, zoom: 1 };
    const side = Math.max(1, Math.round(Math.min(width, height) / region.zoom));
    const data = await image
      .extract({
        left: Math.round((width - side) * region.x),
        top: Math.round((height - side) * region.y),
        width: side,
        height: side,
      })
      .resize(256, 256)
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    return { data, width, height };
  } catch (error) {
    if ((error as any)?.apiCode) throw error;
    return fail(
      'INVALID_IMAGE',
      'Не удалось обработать это фото. Выберите другое изображение',
      400,
    );
  }
}

export function registerAvatarRoutes(app: FastifyInstance) {
  app.get('/api/users/:id/avatar', async (req, reply) => {
    const userId = parse(uuid, params(req).id);
    const viewer = currentUser(req);
    const r = await pool.query(
      `SELECT a.image,a.etag FROM user_avatars a JOIN users u ON u.id=a.user_id
       WHERE a.user_id=$1 AND (u.id=$2 OR (u.company=$3 AND u.is_demo=$4))`,
      [userId, viewer.id, viewer.company, !!viewer.isDemo],
    );
    if (!r.rows[0]) fail('NOT_FOUND', 'Аватар не найден', 404);
    const etag = `"${r.rows[0].etag}"`;
    reply.header('ETag', etag).header('Cache-Control', 'private, max-age=86400');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/webp').send(r.rows[0].image);
  });
  app.post('/api/account/avatar/preview', { bodyLimit: 36 * 1024 * 1024 }, async (req, reply) => {
    await gate('account');
    const { imageBase64 } = parse(previewUpload, body(req));
    const { data, width, height } = await withAvatarConversionSlot(() =>
      renderImage(imageBase64, undefined, true),
    );
    reply.header('Cache-Control', 'no-store');
    return { imageBase64: data.toString('base64'), width, height };
  });
  app.put('/api/account/avatar', { bodyLimit: 36 * 1024 * 1024 }, async (req) => {
    await gate('account');
    const { imageBase64, crop } = parse(upload, body(req));
    const { data: image } = await withAvatarConversionSlot(() => renderImage(imageBase64, crop));
    const etag = createHash('sha256').update(image).digest('hex');
    const userId = currentUser(req).id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO user_avatars(user_id,image,etag) VALUES($1,$2,$3)
        ON CONFLICT(user_id) DO UPDATE SET image=$2,etag=$3,updated_at=now()`,
        [userId, image, etag],
      );
      const r = await c.query('UPDATE users SET avatar_version=$2 WHERE id=$1 RETURNING *', [
        userId,
        etag.slice(0, 24),
      ]);
      await c.query('COMMIT');
      return { user: userDto(r.rows[0]) };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  });
  app.delete('/api/account/avatar', async (req) => {
    await gate('account');
    const userId = currentUser(req).id;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM user_avatars WHERE user_id=$1', [userId]);
      const r = await c.query('UPDATE users SET avatar_version=NULL WHERE id=$1 RETURNING *', [
        userId,
      ]);
      await c.query('COMMIT');
      return { user: userDto(r.rows[0]) };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  });
}

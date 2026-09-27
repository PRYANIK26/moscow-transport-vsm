import { Worker } from 'node:worker_threads';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 128_000_000;
const TIMEOUT_MS = 20_000;
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'heif',
]);

export function isHeic(bytes: Buffer): boolean {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp')
    return false;
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize < 16 || boxSize > bytes.length || (boxSize - 16) % 4 !== 0) return false;
  const brands = [bytes.toString('ascii', 8, 12)];
  for (let offset = 16; offset + 4 <= boxSize; offset += 4)
    brands.push(bytes.toString('ascii', offset, offset + 4));
  // Generic mif1/miaf is shared by AVIF: keep AVIF on the existing sharp path.
  return (
    !brands.some((brand) => brand === 'avif' || brand === 'avis') &&
    brands.some((brand) => HEIC_BRANDS.has(brand))
  );
}

export async function decodeHeic(
  bytes: Buffer,
  maxPixels: number,
): Promise<{ data: Buffer; width: number; height: number }> {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES)
    throw new Error('Размер HEIC файла превышает предел 25 МБ');
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > MAX_PIXELS)
    throw new Error('Неверный предел пикселей HEIC');
  if (!isHeic(bytes)) throw new Error('Файл не является HEIC/HEIF');

  // Copy only the bounded encoded input. Transferring the copy does not detach the caller's Buffer.
  const encoded = new Uint8Array(bytes);
  const worker = new Worker(new URL('./heic-worker.mjs', import.meta.url), {
    workerData: { encoded, maxPixels },
    transferList: [encoded.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: 256,
      maxYoungGenerationSizeMb: 32,
      stackSizeMb: 8,
    },
  });
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = async (
      error?: Error,
      result?: { data: Buffer; width: number; height: number },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.removeAllListeners();
      try {
        await worker.terminate();
      } catch {
        // A worker that already exited needs no further cleanup.
      }
      if (error) reject(error);
      else resolve(result!);
    };
    const timeout = setTimeout(() => {
      void finish(new Error('Время обработки HEIC истекло'));
    }, TIMEOUT_MS);
    worker.on('message', (message: unknown) => {
      const value = message as {
        ok?: boolean;
        data?: unknown;
        width?: number;
        height?: number;
      };
      const data = value?.data;
      if (
        value?.ok !== true ||
        !Number.isSafeInteger(value.width) ||
        !Number.isSafeInteger(value.height) ||
        !value.width ||
        !value.height ||
        value.width > maxPixels / value.height ||
        !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
        data.byteLength !== value.width * value.height * 4
      ) {
        void finish(new Error('Не удалось прочитать HEIC/HEIF фото'));
        return;
      }
      void finish(undefined, {
        width: value.width,
        height: value.height,
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      });
    });
    worker.on('error', () => {
      void finish(new Error('Не удалось прочитать HEIC/HEIF фото'));
    });
    worker.on('exit', (code) => {
      if (code !== 0) void finish(new Error('Не удалось прочитать HEIC/HEIF фото'));
    });
  });
}

import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 128_000_000;

async function decode() {
  const { encoded, maxPixels } = workerData;
  if (
    !(encoded instanceof Uint8Array) ||
    !encoded.byteLength ||
    encoded.byteLength > MAX_BYTES ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels < 1 ||
    maxPixels > MAX_PIXELS
  )
    throw new Error('Неверные параметры HEIC');

  // WASM and all image decoding run inside this worker, never on the HTTP event loop.
  // The bundled build resolves its WASM relative to the package and does not need a disk copy.
  const libheif = require('libheif-js/wasm-bundle');
  const images = new libheif.HeifDecoder().decode(encoded);
  if (!Array.isArray(images) || !images.length) throw new Error('HEIC не содержит изображения');
  const image = images.find((item) => item.is_primary()) ?? images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > maxPixels / height
  )
    throw new Error('Размер HEIC превышает предел');

  // Validate dimensions before allocating the RGBA destination. The caller also checks them.
  const expectedLength = width * height * 4;
  const destination = new Uint8ClampedArray(expectedLength);
  const displayed = await new Promise((resolve, reject) => {
    image.display({ data: destination, width, height }, (value) => {
      if (value) resolve(value);
      else reject(new Error('HEIC не удалось декодировать'));
    });
  });
  if (
    displayed.width !== width ||
    displayed.height !== height ||
    !(displayed.data instanceof Uint8Array || displayed.data instanceof Uint8ClampedArray) ||
    displayed.data.byteLength !== expectedLength
  )
    throw new Error('Некорректный результат HEIC decoder');

  // Transfer ownership of the RGBA array back to the parent without a second full-size copy.
  const data = displayed.data;
  const transfer =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  parentPort.postMessage({ ok: true, width, height, data: transfer }, [transfer.buffer]);
}

// libheif-js prints details of broken containers to console.log. Keep malformed user input out
// of the API logs; the parent receives only a bounded, generic error.
console.log = () => {};
decode().catch(() => {
  parentPort.postMessage({ ok: false, error: 'Не удалось прочитать HEIC/HEIF фото' });
});

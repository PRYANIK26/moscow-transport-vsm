import { useRef, type PointerEvent, type KeyboardEvent } from 'react';
import type { AvatarCrop, AvatarPreview } from '@vsm/shared';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
export const DEFAULT_CROP: AvatarCrop = { x: 0.5, y: 0.5, zoom: 1 };

export function AvatarCropper({
  preview,
  crop,
  onChange,
  disabled,
}: {
  preview: AvatarPreview;
  crop: AvatarCrop;
  onChange: (value: AvatarCrop) => void;
  disabled: boolean;
}) {
  const drag = useRef<{ id: number; x: number; y: number; crop: AvatarCrop } | null>(null);
  const side = Math.min(preview.width, preview.height) / crop.zoom;
  const scaleX = preview.width / side,
    scaleY = preview.height / side;
  function move(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || disabled) return;
    const width = event.currentTarget.clientWidth;
    onChange({
      ...crop,
      x:
        scaleX > 1 ? clamp(start.crop.x - (event.clientX - start.x) / ((scaleX - 1) * width)) : 0.5,
      y:
        scaleY > 1 ? clamp(start.crop.y - (event.clientY - start.y) / ((scaleY - 1) * width)) : 0.5,
    });
  }
  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
      return;
    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.025;
    onChange({
      ...crop,
      x: clamp(
        crop.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
      ),
      y: clamp(crop.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)),
    });
  }
  return (
    <div className="avatar-cropper">
      <div
        className="avatar-crop-viewport"
        role="group"
        aria-label="Область аватара"
        aria-describedby="avatar-crop-help"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={keyboard}
        onPointerDown={(event) => {
          if (disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, crop };
        }}
        onPointerMove={move}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <img
          src={`data:image/webp;base64,${preview.imageBase64}`}
          alt="Предпросмотр нового фото профиля"
          draggable={false}
          style={{
            width: `${scaleX * 100}%`,
            height: `${scaleY * 100}%`,
            left: `${-(scaleX - 1) * crop.x * 100}%`,
            top: `${-(scaleY - 1) * crop.y * 100}%`,
          }}
        />
      </div>
      <p id="avatar-crop-help" className="muted">
        Перемещайте фото, чтобы выбрать область. Можно использовать стрелки на клавиатуре.
      </p>
      <label className="avatar-zoom">
        Масштаб
        <input
          aria-label="Масштаб фото"
          type="range"
          min="1"
          max="5"
          step="0.05"
          value={crop.zoom}
          disabled={disabled}
          onChange={(event) => onChange({ ...crop, zoom: Number(event.target.value) })}
        />
      </label>
      <button
        type="button"
        className="text-button"
        disabled={disabled}
        onClick={() => onChange({ ...DEFAULT_CROP })}
      >
        По центру
      </button>
    </div>
  );
}

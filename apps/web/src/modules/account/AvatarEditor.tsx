import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import type { User, AvatarCrop, AvatarPreview } from '@vsm/shared';
import { api } from '../../lib/api';
import { Avatar } from '../../lib/Avatar';
import { errorText } from '../../lib/ui';

import { AvatarCropper, DEFAULT_CROP } from './AvatarCropper';

const MAX_BYTES = 25 * 1024 * 1024;

function readOriginal(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать фото. Выберите его снова.'));
    reader.onabort = () => reject(new Error('Чтение фото прервано. Повторите попытку.'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('Не удалось прочитать фото. Выберите его снова.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export function AvatarEditor({ user, onChange }: { user: User; onChange: (user: User) => void }) {
  const [selected, setSelected] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<{ original: string; preview: AvatarPreview } | null>(
    null,
  );
  const [crop, setCrop] = useState<AvatarCrop>({ ...DEFAULT_CROP });
  const [preparing, setPreparing] = useState(false);
  const generation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );

  async function prepare(file: File) {
    const current = ++generation.current;
    setPreparing(true);
    setError('');
    setPrepared(null);
    try {
      const original = await readOriginal(file);
      if (current !== generation.current) return;
      const preview = await api.post<AvatarPreview>('/account/avatar/preview', {
        imageBase64: original,
      });
      if (current === generation.current) setPrepared({ original, preview });
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
    } finally {
      if (current === generation.current) setPreparing(false);
    }
  }

  function reset() {
    setSelected(null);
    generation.current++;
    setPrepared(null);
    setPreparing(false);
    setCrop({ ...DEFAULT_CROP });
    setError('');
    setMessage('');
  }

  function select(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    reset();
    if (file.size > MAX_BYTES) {
      setError('Фото слишком большое. Выберите файл до 25 МБ.');
      return;
    }
    setSelected(file);
    void prepare(file);
  }

  async function save() {
    if (!selected || !prepared || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const imageBase64 = prepared.original;
      const result = await api.put<{ user: User }>('/account/avatar', { imageBase64, crop });
      onChange(result.user);
      setSelected(null);
      setPrepared(null);
      setMessage('Фото профиля сохранено.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    reset();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await api.delete<{ user: User }>('/account/avatar');
      onChange(result.user);
      setSelected(null);
      setPrepared(null);
      setMessage('Фото профиля удалено.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="avatar-editor">
      {prepared ? (
        <AvatarCropper preview={prepared.preview} crop={crop} onChange={setCrop} disabled={busy} />
      ) : (
        <Avatar user={user} className="avatar-profile" />
      )}
      <div className="avatar-editor-actions">
        <label className="button" htmlFor="profile-avatar">
          <ImagePlus size={17} /> Выбрать фото
        </label>
        <input id="profile-avatar" type="file" accept="image/*" onChange={select} disabled={busy} />
        {selected && (
          <>
            <p className="muted" style={{ overflowWrap: 'anywhere' }}>
              {selected.name}
            </p>
          </>
        )}
        <div className="button-row">
          {selected && (
            <>
              <button
                className="button primary"
                disabled={busy || !prepared || preparing}
                onClick={() => void save()}
              >
                {busy ? 'Обрабатываем фото…' : 'Сохранить фото'}
              </button>
              <button className="text-button" disabled={busy} onClick={reset}>
                Отменить выбор
              </button>
            </>
          )}
          {user.avatarUrl && (
            <button className="button" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={17} /> Удалить фото
            </button>
          )}
        </div>
        {preparing && <p role="status">Готовим предпросмотр…</p>}
        {selected && !preparing && !prepared && error && (
          <button type="button" className="text-button" onClick={() => void prepare(selected)}>
            Повторить подготовку
          </button>
        )}
        {busy && <p role="status">Обрабатываем фото…</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="form-success" role="status">
            {message}
          </p>
        )}
      </div>
    </div>
  );
}

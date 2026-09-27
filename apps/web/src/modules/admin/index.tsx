import { useState } from 'react';
import { ShieldCheck, UserCog } from 'lucide-react';
import { MODULE_IDS, type ModuleFlags, type Role, type User } from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText, roleName, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

const LABELS: Record<keyof ModuleFlags, { title: string; description: string }> = {
  account: { title: 'Личный кабинет', description: 'Профиль и обзор доступных разделов' },
  play: { title: 'Игра', description: 'Каталог, сессии и игровые действия' },
  immersive: { title: '3D-вагон', description: 'Пространственные действия в опубликованных сценариях' },
  voice: { title: 'Голос', description: 'Распознавание и озвучивание реплик в 3D-тренировке' },
  materials: { title: 'Материалы', description: 'Опубликованные учебные материалы и источники' },
  editor: { title: 'Редактор', description: 'Создание и публикация сценариев' },
  notifications: { title: 'Уведомления', description: 'Сохранённая лента сообщений' },
  progress: { title: 'Прогресс', description: 'Достижения и история результатов' },
  leaderboard: { title: 'Лидерборд', description: 'Лучшие результаты проводников за 30 дней' },
  team: { title: 'Бригада', description: 'Рейтинги бригады, депо и компании' },
};
const ROLES: Role[] = ['student', 'author', 'admin'];
export default function Admin() {
  const { modules, setModules } = useAuth();
  const users = useResource(() => api.get<User[]>('/admin/users'));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function toggle(id: keyof ModuleFlags) {
    if (busy) return;
    setBusy(id);
    setError('');
    setSuccess('');
    const before = modules;
    try {
      const updated = await api.patch<ModuleFlags>(`/modules/${id}`, { enabled: !before[id] });
      setModules(updated);
      setSuccess(`${LABELS[id].title}: ${updated[id] ? 'включён' : 'выключен'}.`);
    } catch (e) {
      setModules(before);
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  async function role(id: string, selected: Role) {
    if (busy) return;
    setBusy(id);
    setError('');
    setSuccess('');
    try {
      const updated = await api.patch<User>(`/admin/users/${encodeURIComponent(id)}/role`, {
        role: selected,
      });
      users.setValue((list) => list?.map((u) => (u.id === id ? updated : u)) ?? null);
      setSuccess(`Роль ${updated.name} изменена.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Управление</h1>
          <p>Доступность разделов и роли пользователей</p>
        </div>
      </div>
      {error && (
        <div className="inline-warning" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="inline-success" role="status">
          {success}
        </div>
      )}
      <section className="content-section">
        <div className="section-heading">
          <ShieldCheck size={21} />
          <h2>Модули сайта</h2>
        </div>
        <p className="muted">
          Выключение скрывает раздел и блокирует его API. Данные сохраняются. Если выключить игру,
          активные сессии останутся в базе: сроки продолжают идти, а просроченный шаг будет
          обработан после включения игры.
        </p>
        <div className="module-list">
          {MODULE_IDS.map((id) => (
            <div className="module-row" key={id}>
              <div>
                <strong>{LABELS[id].title}</strong>
                <span>{LABELS[id].description}</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={modules[id]}
                aria-label={`${LABELS[id].title}: ${modules[id] ? 'включён' : 'выключен'}`}
                className={'switch ' + (modules[id] ? 'on' : '')}
                disabled={!!busy}
                onClick={() => void toggle(id)}
              >
                <span />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="content-section">
        <div className="section-heading">
          <UserCog size={21} />
          <h2>Права доступа</h2>
        </div>
        <p className="muted">
          Автор и администратор могут открыть редактор, когда он включён. Нельзя понизить роль
          последнего администратора.
        </p>
        {users.loading && !users.value ? (
          <p role="status">Загружаем пользователей…</p>
        ) : users.error && !users.value ? (
          <div className="minor-error">
            {users.error} <button onClick={() => void users.reload()}>Повторить</button>
          </div>
        ) : users.value?.length ? (
          <div className="user-list">
            {users.value.map((u) => (
              <div className="user-row" key={u.id}>
                <div>
                  <strong>{u.name}</strong>
                  <span>
                    {u.email} · {u.brigade}
                  </span>
                </div>
                <label>
                  Роль
                  <select
                    value={u.role}
                    disabled={!!busy}
                    onChange={(e) => void role(u.id, e.target.value as Role)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {roleName(r)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Пользователей пока нет.</p>
        )}
      </section>
    </div>
  );
}

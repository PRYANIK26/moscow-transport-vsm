import { useEffect, useState } from 'react';
import { ArrowRight, Bell, BookOpen, Pencil, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  AccountResponse,
  NotificationsStatus,
  ProgressSummary,
  ScenarioSummary,
} from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText, number, roleName, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';
import { AvatarEditor } from './AvatarEditor';

export default function Account() {
  const { modules, setUser } = useAuth();
  const account = useResource(() => api.get<AccountResponse>('/account'));
  const progress = useResource(
    () => (modules.progress ? api.get<ProgressSummary>('/progress') : Promise.resolve(null)),
    [modules.progress],
  );
  const scenarios = useResource(
    () => (modules.play ? api.get<ScenarioSummary[]>('/scenarios') : Promise.resolve(null)),
    [modules.play],
  );
  const notices = useResource(
    () =>
      modules.notifications
        ? api.get<NotificationsStatus>('/notifications/status')
        : Promise.resolve(null),
    [modules.notifications],
  );
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  useEffect(() => {
    if (account.value) {
      setFirstName(account.value.user.firstName ?? account.value.user.name.split(' ')[0]);
      setLastName(
        account.value.user.lastName ?? account.value.user.name.split(' ').slice(1).join(' '),
      );
    }
  }, [account.value]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim()) return;
    setSaving(true);
    setSaveError('');
    try {
      const data = await api.patch<AccountResponse>('/account', {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });
      account.setValue(data);
      setUser(data.user);
      setEditing(false);
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  if (account.loading && !account.value)
    return (
      <div className="status" role="status">
        Загружаем кабинет…
      </div>
    );
  if (account.error && !account.value)
    return (
      <div className="status status-error" role="alert">
        <p>{account.error}</p>
        <button onClick={() => void account.reload()}>Повторить</button>
      </div>
    );
  const user = account.value!.user;
  function updateAvatar(updated: typeof user) {
    account.setValue((old) => (old ? { ...old, user: updated } : old));
    setUser(updated);
  }
  const suggested = scenarios.value?.find((item) => item.publishedVersion !== null);
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Личный кабинет</h1>
        </div>
      </div>
      <section className="profile-panel">
        <AvatarEditor user={user} onChange={updateAvatar} />
        <div>
          <div className="profile-name">
            <h2>{user.name}</h2>
            <button type="button" className="text-button" onClick={() => setEditing((v) => !v)}>
              <Pencil size={16} /> Изменить имя
            </button>
          </div>
          <p>
            {roleName(user.role)} · {user.brigade} · {user.depot}
          </p>
          <span className="muted">{user.company}</span>
        </div>
        {editing && (
          <form className="name-form" onSubmit={save}>
            <label htmlFor="profile-name">Имя</label>
            <div className="inline-form">
              <input
                id="profile-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                minLength={1}
                maxLength={50}
                required
              />
              <label htmlFor="profile-last-name">Фамилия</label>
              <input
                id="profile-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                minLength={1}
                maxLength={50}
                required
              />
              <button className="button primary" disabled={saving}>
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
            {saveError && (
              <p role="alert" className="form-error">
                {saveError}
              </p>
            )}
          </form>
        )}
      </section>
      <div className="account-grid">
        <section className="feature-panel">
          <div className="section-heading">
            <BookOpen size={21} />
            <h2>Продолжить практику</h2>
          </div>
          {!modules.play ? (
            <p className="muted">
              Тренировки временно недоступны. Ваши прежние результаты сохранены.
            </p>
          ) : scenarios.loading ? (
            <p className="muted">Загружаем сценарии…</p>
          ) : scenarios.error ? (
            <div className="minor-error">
              {scenarios.error} <button onClick={() => void scenarios.reload()}>Повторить</button>
            </div>
          ) : suggested ? (
            <>
              <strong>{suggested.title}</strong>
              <p>{suggested.description}</p>
              <Link className="button primary" to="/scenarios">
                Выбрать сценарий <ArrowRight size={17} />
              </Link>
            </>
          ) : (
            <>
              <p>Опубликованных сценариев пока нет.</p>
              <Link className="button" to="/scenarios">
                Открыть библиотеку
              </Link>
            </>
          )}
        </section>
        {modules.progress && (
          <section className="feature-panel">
            <div className="section-heading">
              <Trophy size={21} />
              <h2>Ваш прогресс</h2>
            </div>
            {progress.loading ? (
              <p className="muted">Загружаем прогресс…</p>
            ) : progress.error ? (
              <div className="minor-error">
                {progress.error} <button onClick={() => void progress.reload()}>Повторить</button>
              </div>
            ) : progress.value ? (
              <>
                <div className="stat-line">
                  <span>
                    Уровень {progress.value.level} · {progress.value.levelTitle}
                  </span>
                  <strong>{number(progress.value.xp)} XP</strong>
                </div>
                <div className="stat-line">
                  <span>Завершено тренировок</span>
                  <strong>{number(progress.value.completedSessions)}</strong>
                </div>
                <Link className="text-link" to="/progress">
                  Подробный прогресс <ArrowRight size={16} />
                </Link>
              </>
            ) : null}
          </section>
        )}
        {modules.notifications && (
          <section className="feature-panel">
            <div className="section-heading">
              <Bell size={21} />
              <h2>Уведомления</h2>
            </div>
            {notices.loading ? (
              <p className="muted">Загружаем уведомления…</p>
            ) : notices.error ? (
              <div className="minor-error">
                {notices.error} <button onClick={() => void notices.reload()}>Повторить</button>
              </div>
            ) : (
              <>
                <div className="stat-line">
                  <span>Непрочитанные</span>
                  <strong>{notices.value?.unreadCount ?? 0}</strong>
                </div>
                <Link className="text-link" to="/notifications">
                  Открыть ленту <ArrowRight size={16} />
                </Link>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

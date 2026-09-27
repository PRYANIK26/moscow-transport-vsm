import { useEffect, useRef, useState } from 'react';
import { Bell, CheckCheck, ChevronLeft, ChevronRight, ExternalLink, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type {
  ModuleFlags,
  Notification,
  NotificationFeed,
  NotificationFeedType,
  NotificationFeedStatus,
  NotificationFeedSort,
} from '@vsm/shared';
import { api } from '../../lib/api';
import { dateTime, errorText, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';
import { notificationChanged } from '../../lib/notificationStatus';
import { PushSettings } from './PushSettings';
import './notifications.css';

const PAGE_SIZE = 50;
const TYPES: Record<Notification['type'], string> = {
  scenario: 'Сценарий',
  challenge: 'Задание',
  expiry: 'Баллы',
  achievement: 'Достижение',
  system: 'Система',
};
const TYPE_OPTIONS: { value: NotificationFeedType; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'scenario', label: 'Новые сценарии' },
  { value: 'achievement', label: 'Достижения' },
  { value: 'challenge', label: 'Задания' },
  { value: 'expiry', label: 'Баллы' },
  { value: 'system', label: 'Система' },
];
function localHref(href: string | null) {
  if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null;
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin &&
      /^\/(scenarios|play\/[\w-]+|progress|results\/[\w-]+|team|account|notifications)(\?.*)?$/.test(
        url.pathname + url.search,
      )
      ? url.pathname + url.search
      : null;
  } catch {
    return null;
  }
}
function enabledHref(href: string | null, modules: ModuleFlags) {
  const path = localHref(href);
  if (!path) return null;
  const module =
    path.startsWith('/play/') || path.startsWith('/scenarios')
      ? 'play'
      : path.startsWith('/results/') || path.startsWith('/progress')
        ? 'progress'
        : path.startsWith('/team')
          ? 'team'
          : path.startsWith('/account')
            ? 'account'
            : 'notifications';
  return modules[module] ? path : null;
}

export default function Notifications() {
  const { modules } = useAuth();
  const [type, setType] = useState<NotificationFeedType>('all');
  const [status, setStatus] = useState<NotificationFeedStatus>('all');
  const [sort, setSort] = useState<NotificationFeedSort>('newest');
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState('');
  const pending = useRef(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const feed = useResource<NotificationFeed>(() => {
    const query = new URLSearchParams({
      type,
      status,
      sort,
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });
    return api.get(`/notifications/feed?${query}`);
  }, [type, status, sort, offset]);
  useEffect(() => {
    if (feed.value && feed.value.offset !== offset) setOffset(feed.value.offset);
  }, [feed.value?.offset, offset]);

  function changeFilter<T>(setter: (value: T) => void, value: T) {
    if (pending.current) return;
    setOffset(0);
    setError('');
    setMessage('');
    setter(value);
  }
  async function mutate<T>(
    key: string,
    operation: () => Promise<T>,
    success?: (result: T) => string,
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(key);
    setError('');
    setMessage('');
    try {
      const result = await operation();
      notificationChanged();
      const refreshed = await feed.reload();
      if (!refreshed) {
        setError('Действие выполнено, но список не обновился. Повторите загрузку.');
        return;
      }
      if (refreshed.offset !== offset) setOffset(refreshed.offset);
      if (success) setMessage(success(result));
      if (key === 'clear') setConfirmClear(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      pending.current = false;
      setBusy('');
    }
  }
  const data = feed.value;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const currentPage = Math.floor((data?.offset ?? offset) / PAGE_SIZE) + 1;
  const hasFilters = type !== 'all' || status !== 'all';
  return (
    <div className="page notifications-page">
      <div className="page-heading notifications-heading">
        <div>
          <span className="second-eyebrow">НА БОРТУ · СООБЩЕНИЯ</span>
          <h1>Уведомления</h1>
          {data && (
            <p>
              Непрочитанных: {data.unreadCount} · Прочитанных: {data.readCount}
            </p>
          )}
        </div>
        <div className="notifications-heading-actions">
          <button
            type="button"
            className="button"
            disabled={!!busy || !data?.unreadCount}
            onClick={() => void mutate('read-all', () => api.post('/notifications/read-all'))}
          >
            <CheckCheck size={17} /> {busy === 'read-all' ? 'Отмечаем…' : 'Прочитать все'}
          </button>
          <button
            type="button"
            className="button"
            disabled={!!busy || !data?.readCount}
            aria-expanded={confirmClear}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={16} /> Удалить все прочитанные
          </button>
        </div>
      </div>
      {confirmClear && data && (
        <div className="notifications-confirm" role="group" aria-label="Подтверждение очистки">
          <p>
            Прочитанных уведомлений: {data.readCount}. Удалить всю прочитанную историю во всех
            категориях, включая другие страницы?
          </p>
          <div>
            <button
              type="button"
              className="button"
              disabled={!!busy}
              onClick={() => setConfirmClear(false)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button primary"
              disabled={!!busy || !data.readCount}
              onClick={() =>
                void mutate(
                  'clear',
                  () => api.delete<{ deleted: number }>('/notifications/read'),
                  (result) => `Удалено прочитанных уведомлений: ${result.deleted}.`,
                )
              }
            >
              {busy === 'clear' ? 'Удаляем…' : 'Подтвердить удаление'}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="inline-warning" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="form-success" role="status">
          {message}
        </div>
      )}
      <div className="notifications-controls">
        <label>
          Тип
          <select
            aria-label="Тип"
            value={type}
            disabled={!!busy}
            onChange={(event) => changeFilter(setType, event.target.value as NotificationFeedType)}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Статус
          <select
            aria-label="Статус"
            value={status}
            disabled={!!busy}
            onChange={(event) =>
              changeFilter(setStatus, event.target.value as NotificationFeedStatus)
            }
          >
            <option value="all">Все</option>
            <option value="unread">Непрочитанные</option>
            <option value="read">Прочитанные</option>
          </select>
        </label>
        <label>
          Сортировка
          <select
            aria-label="Сортировка"
            value={sort}
            disabled={!!busy}
            onChange={(event) => changeFilter(setSort, event.target.value as NotificationFeedSort)}
          >
            <option value="newest">Сначала новые</option>
            <option value="oldest">Сначала старые</option>
          </select>
        </label>
      </div>
      {feed.loading && !data ? (
        <div className="status" role="status">
          Загружаем уведомления…
        </div>
      ) : feed.error && !data ? (
        <div className="status status-error" role="alert">
          <p>{feed.error}</p>
          <button type="button" onClick={() => void feed.reload()}>
            Повторить
          </button>
        </div>
      ) : data ? (
        <>
          {feed.error && (
            <p className="inline-warning" role="alert">
              {feed.error}{' '}
              <button type="button" onClick={() => void feed.reload()}>
                Повторить
              </button>
            </p>
          )}
          <div className="notifications-range" role="status">
            <span>
              {data.total
                ? `${data.offset + 1}–${data.offset + data.items.length} из ${data.total}`
                : '0 уведомлений'}
            </span>
            {feed.loading && <span>Обновляем…</span>}
          </div>
          {data.items.length ? (
            <div className="notification-list">
              {data.items.map((notice) => {
                const href = enabledHref(notice.href, modules);
                return (
                  <article
                    key={notice.id}
                    data-notification-id={notice.id}
                    className={'notification ' + (!notice.readAt ? 'unread' : '')}
                  >
                    <div className="notification-icon">
                      <Bell size={20} />
                    </div>
                    <div className="notification-body">
                      <div className="notification-meta">
                        <span>{TYPES[notice.type]}</span>
                        <time dateTime={notice.createdAt}>{dateTime(notice.createdAt)}</time>
                      </div>
                      <h2>{notice.title}</h2>
                      <p>{notice.body}</p>
                      <div className="notification-actions">
                        {href && (
                          <Link
                            to={href}
                            onClick={() => {
                              if (!notice.readAt)
                                void mutate(notice.id, () =>
                                  api.patch(`/notifications/${encodeURIComponent(notice.id)}`, {
                                    read: true,
                                  }),
                                );
                            }}
                          >
                            Открыть <ExternalLink size={15} />
                          </Link>
                        )}
                        {!notice.readAt ? (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() =>
                              void mutate(notice.id, () =>
                                api.patch(`/notifications/${encodeURIComponent(notice.id)}`, {
                                  read: true,
                                }),
                              )
                            }
                          >
                            {busy === notice.id ? 'Сохраняем…' : 'Отметить прочитанным'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={!!busy}
                            onClick={() =>
                              void mutate(
                                notice.id,
                                () =>
                                  api.delete<{ deleted: number }>(
                                    `/notifications/${encodeURIComponent(notice.id)}`,
                                  ),
                                (result) =>
                                  result.deleted
                                    ? 'Уведомление удалено.'
                                    : 'Уведомление уже удалено.',
                              )
                            }
                          >
                            {busy === notice.id ? 'Удаляем…' : 'Удалить'}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="status notifications-empty">
              <Bell size={28} />
              <h2>
                {data.unreadCount + data.readCount
                  ? 'По выбранным фильтрам уведомлений нет'
                  : 'Уведомлений пока нет'}
              </h2>
              {hasFilters && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setType('all');
                    setStatus('all');
                    setOffset(0);
                  }}
                >
                  Сбросить фильтры
                </button>
              )}
            </div>
          )}
          {data.total > PAGE_SIZE && (
            <nav className="notifications-pagination" aria-label="Страницы уведомлений">
              <button
                type="button"
                className="button"
                disabled={!!busy || data.offset === 0}
                onClick={() => setOffset(Math.max(0, data.offset - PAGE_SIZE))}
              >
                <ChevronLeft size={17} /> Назад
              </button>
              <span>
                Страница {currentPage} из {totalPages}
              </span>
              <button
                type="button"
                className="button"
                disabled={!!busy || data.offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset(data.offset + PAGE_SIZE)}
              >
                Далее <ChevronRight size={17} />
              </button>
            </nav>
          )}
        </>
      ) : null}
      <PushSettings />
    </div>
  );
}

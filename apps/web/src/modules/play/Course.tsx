import { scenarioDescription } from '../../lib/scenarioCopy';
import { useRef, useState } from 'react';
import { ArrowRight, BookOpen, Route } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { ScenarioSummary, SessionSummary, SessionView } from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

export default function Course() {
  const navigate = useNavigate();
  const { modules } = useAuth();
  const catalog = useResource(() => api.get<ScenarioSummary[]>('/scenarios'));
  const sessions = useResource(() => api.get<SessionSummary[]>('/sessions'));
  const keys = useRef<Record<string, string>>({});
  const [starting, setStarting] = useState('');
  const [error, setError] = useState('');
  const routes =
    catalog.value?.filter((item) => item.kind === 'mega' && item.publishedVersion !== null) ?? [];
  async function start(id: string) {
    if (starting) return;
    setStarting(id);
    setError('');
    const requestId = keys.current[id] ?? crypto.randomUUID();
    keys.current[id] = requestId;
    try {
      const view = await api.post<SessionView>('/sessions', { scenarioId: id, requestId });
      delete keys.current[id];
      navigate(
        `/${view.world && modules.immersive ? 'immersive' : 'play'}/${encodeURIComponent(view.id)}`,
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setStarting('');
    }
  }
  async function resume(id: string) {
    if (starting) return;
    setStarting(id);
    setError('');
    try {
      const view = await api.get<SessionView>(`/sessions/${encodeURIComponent(id)}`);
      navigate(`/${view.world && modules.immersive ? 'immersive' : 'play'}/${encodeURIComponent(view.id)}`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setStarting('');
    }
  }
  const lessons =
    catalog.value?.filter((item) => item.kind === 'scenario' && item.publishedVersion !== null) ??
    [];
  const featured = routes.find((item) => /^Курс:/i.test(item.title)) ?? routes[0];
  const active = sessions.value?.find(
    (session) => session.status === 'active' && session.scenarioId === featured?.id,
  );
  return (
    <div className="page second-course">
      {error && (
        <p className="inline-warning" role="alert">
          {error} Повторный запуск использует тот же запрос.
        </p>
      )}
      <section className="course-hero">
        <div className="course-intro">
          <span className="course-eyebrow">ПРАКТИКА В ВИРТУАЛЬНОМ ПОЕЗДЕ</span>
          <h1>
            Спокойствие
            <br />
            на борту.
          </h1>
          <p>Учитесь слышать пассажиров и находить решение в рабочих ситуациях.</p>
          <div className="course-facts">
            <span>{lessons.length} опубликованных ситуаций</span>
            <span>Один кабинет и история результатов</span>
          </div>
        </div>
        <div className="current-level">
          <div className="current-level-top">
            <span>{active ? 'ПРОДОЛЖИТЬ ОБУЧЕНИЕ' : 'МАРШРУТ КУРСА'}</span>
            <Route size={22} />
          </div>
          <h2>{active?.title || featured?.title || 'Курс готовится'}</h2>
          <p>
            {(featured?.description && scenarioDescription(featured.description)) ||
              'Пока можно тренироваться на отдельных опубликованных ситуациях.'}
          </p>
          {active ? (
            <button type="button" className="button primary" disabled={!!starting} onClick={() => void resume(active.id)}>
              Продолжить <ArrowRight size={18} />
            </button>
          ) : featured ? (
            <button
              className="button primary"
              disabled={!!starting}
              onClick={() => void start(featured.id)}
            >
              {starting ? 'Запускаем…' : 'Начать обучение'} <ArrowRight size={18} />
            </button>
          ) : (
            <Link className="button primary" to="/scenarios">
              Открыть практику <ArrowRight size={18} />
            </Link>
          )}
          <div className="course-progress">
            <div>
              <span>Опубликованных маршрутов</span>
              <span>{routes.length}</span>
            </div>
            <div className="course-progress-line" />
          </div>
        </div>
      </section>
      <section className="course-program">
        <div className="section-heading">
          <h2>Программа практики</h2>
          <p>Тренируйте темы отдельно или начните опубликованный маршрут курса.</p>
        </div>
        {catalog.loading && !catalog.value ? (
          <p role="status">Загружаем курс…</p>
        ) : catalog.error && !catalog.value ? (
          <p role="alert">
            {catalog.error} <button onClick={() => void catalog.reload()}>Повторить</button>
          </p>
        ) : lessons.length ? (
          <div className="level-list">
            {lessons.map((item, index) => (
              <button
                type="button"
                className="level-row"
                disabled={!!starting}
                onClick={() => void start(item.id)}
                key={item.id}
              >
                <span className="level-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="level-title">
                  <strong>{item.title}</strong>
                  <small>
                    {item.estimatedMinutes} мин · опубликованная версия {item.publishedVersion}
                  </small>
                </span>
                <ArrowRight className="level-state" size={17} />
              </button>
            ))}
          </div>
        ) : (
          <div className="learning-empty">
            <BookOpen size={30} />
            <h3>Ситуации готовятся</h3>
            <p>Пока нет опубликованных ситуаций.</p>
          </div>
        )}
      </section>
    </div>
  );
}

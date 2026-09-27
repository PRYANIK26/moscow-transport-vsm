import { scenarioDescription } from '../../lib/scenarioCopy';
import { useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Filter, PlayCircle, Route, Box, Search } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  COMPETENCY_LABELS,
  type ScenarioSummary,
  type SessionSummary,
  type SessionView,
} from '@vsm/shared';
import { api } from '../../lib/api';
import { className, difficultyName, errorText, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

export default function Scenarios() {
  const navigate = useNavigate();
  const { modules } = useAuth();
  const catalog = useResource(() => api.get<ScenarioSummary[]>('/scenarios'));
  const sessions = useResource(() => api.get<SessionSummary[]>('/sessions'));
  const [query, setQuery] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [service, setService] = useState('');
  const [kind, setKind] = useState('scenario');
  const [competency, setCompetency] = useState('');
  const [starting, setStarting] = useState('');
  const [startError, setStartError] = useState('');
  const keys = useRef<Record<string, string>>({});
  const list = useMemo(
    () =>
      catalog.value?.filter(
        (item) =>
          item.publishedVersion !== null &&
          (!query ||
            `${item.title} ${item.description}`
              .toLocaleLowerCase('ru')
              .includes(query.toLocaleLowerCase('ru'))) &&
          (!difficulty || item.difficulty === difficulty) &&
          (!service || item.serviceClass === service) &&
          (!kind || item.kind === kind) &&
          (!competency || item.competencies.includes(competency as keyof typeof COMPETENCY_LABELS)),
      ) ?? [],
    [catalog.value, query, difficulty, service, kind, competency],
  );
  async function start(id: string) {
    if (starting) return;
    setStarting(id);
    setStartError('');
    const requestId = keys.current[id] ?? crypto.randomUUID();
    keys.current[id] = requestId;
    try {
      const view = await api.post<SessionView>('/sessions', { scenarioId: id, requestId });
      delete keys.current[id];
      navigate(`/${view.world && modules.immersive ? 'immersive' : 'play'}/${encodeURIComponent(view.id)}`);
    } catch (e) {
      setStartError(errorText(e));
    } finally {
      setStarting('');
    }
  }
  async function resume(id: string) {
    if (starting) return;
    setStarting(id);
    setStartError('');
    try {
      const view = await api.get<SessionView>(`/sessions/${encodeURIComponent(id)}`);
      navigate(`/${view.world && modules.immersive ? 'immersive' : 'play'}/${encodeURIComponent(view.id)}`);
    } catch (e) {
      setStartError(errorText(e));
    } finally {
      setStarting('');
    }
  }
  const active = sessions.value?.filter((item) => item.status === 'active') ?? [];
  return (
    <div className="page second-practice">
      <div className="page-heading">
        <div>
          <span className="second-eyebrow">СВОБОДНАЯ ПРАКТИКА</span>
          <h1>Выберите ситуацию</h1>
          <p>Повторяйте отдельные навыки в любом порядке. На каждый шаг отведено время.</p>
        </div>
      </div>
      {active.length > 0 && (
        <section className="resume-strip">
          <h2>Незавершённые тренировки</h2>
          <div className="resume-list">
            {active.map((item) => (
              <button
                type="button"
                className="resume-item"
                key={item.id}
                disabled={!!starting}
                onClick={() => void resume(item.id)}
              >
                <span>{item.title}</span>
                <strong>
                  Продолжить <ArrowRight size={16} />
                </strong>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="second-catalog-toolbar">
        <div className="second-tabs" role="group" aria-label="Тема тренировки">
          {[
            { label: 'Все ситуации', value: '' },
            { label: 'Сервис', value: 'service' },
            { label: 'Конфликты', value: 'conflict' },
            { label: 'Безопасность', value: 'safety' },
            { label: 'Общение', value: 'communication' },
          ].map((topic) => <button key={topic.value} type="button" className={competency === topic.value ? 'selected' : ''} aria-pressed={competency === topic.value} onClick={() => setCompetency(topic.value)}>{topic.label}</button>)}
        </div>
        <label className="second-search-box"><Search size={18} /><input type="search" value={query} placeholder="Поиск" aria-label="Найти ситуацию" onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      <details className="second-advanced-filters">
        <summary><Filter size={16} /> Дополнительные фильтры</summary>
        <section className="filters" aria-label="Дополнительные фильтры">
        <label>
          Сложность
          <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="">Любая</option>
            <option value="beginner">Начальная</option>
            <option value="intermediate">Средняя</option>
            <option value="advanced">Сложная</option>
          </select>
        </label>
        <label>
          Класс
          <select value={service} onChange={(e) => setService(e.target.value)}>
            <option value="">Любой</option>
            <option value="standard">Стандарт</option>
            <option value="comfort">Комфорт</option>
            <option value="business">Бизнес</option>
            <option value="first">Первый класс</option>
            <option value="any">Все классы</option>
          </select>
        </label>
        <label>
          Тип
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Любой</option>
            <option value="scenario">Сценарий</option>
            <option value="mega">Маршрут</option>
          </select>
        </label>
        </section>
      </details>
      {startError && (
        <div className="inline-warning" role="alert">
          {startError} Повторите запуск: повторный запрос не создаст вторую тренировку.
        </div>
      )}
      {catalog.loading && !catalog.value ? (
        <div className="status" role="status">
          Загружаем библиотеку…
        </div>
      ) : catalog.error && !catalog.value ? (
        <div className="status status-error" role="alert">
          <p>{catalog.error}</p>
          <button onClick={() => void catalog.reload()}>Повторить</button>
        </div>
      ) : !list.length ? (
        <div className="status">
          <BookEmpty />
          <h2>
            {catalog.value?.length
              ? 'По фильтрам ничего не найдено'
              : 'Пока нет опубликованных сценариев'}
          </h2>
          <p>
            {catalog.value?.length
              ? 'Попробуйте изменить поиск или фильтры.'
              : 'Когда автор опубликует первый сценарий, он появится здесь.'}
          </p>
          {(catalog.value?.length ?? 0) > 0 && (
            <button
              onClick={() => {
                setQuery('');
                setDifficulty('');
                setService('');
                setKind('');
                setCompetency('');
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="second-result-count">{list.length} {list.length === 1 ? 'ситуация' : 'ситуаций'}</div>
          <div className="scenario-list second-scenario-grid">
            {list.map((item) => (
              <article className="scenario-row second-scenario-card" key={item.id}>
                <div className="second-card-top">{item.kind === 'mega' ? <Route size={23} /> : item.presentation === 'immersive' ? <Box size={23} /> : <PlayCircle size={23} />}<small>{item.estimatedMinutes} мин</small></div>
                <div className="second-card-content">
                  <span className="second-eyebrow">{item.kind === 'mega' ? 'МАРШРУТ' : COMPETENCY_LABELS[item.competencies[0]] || 'ПРАКТИКА'}{item.presentation === 'immersive' ? ' · 3D-ВАГОН' : ''}</span>
                  <h3>{item.title}</h3>
                  <p>{scenarioDescription(item.description)}</p>
                  <small>{difficultyName(item.difficulty)} · {className(item.serviceClass)}</small>
                </div>
                <button
                  className="second-card-bottom"
                  disabled={!!starting}
                  onClick={() => void start(item.id)}
                >
                  {starting === item.id ? 'Запускаем…' : 'Начать практику'} <ArrowUpRight size={18} />
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
function BookEmpty() {
  return <Route size={28} aria-hidden="true" />;
}

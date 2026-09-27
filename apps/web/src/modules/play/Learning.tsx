import { useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Clock3, Search } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  MaterialDetail,
  MaterialIndex,
  ResultSummary,
  ScenarioSummary,
  SessionSummary,
  SessionView,
} from '@vsm/shared';
import { api } from '../../lib/api';
import { dateTime, errorText, useResource } from '../../lib/ui';
import { scenarioDescription } from '../../lib/scenarioCopy';
import { useAuth } from '../../shell/App';

type LearningItem = {
  id: string;
  title: string;
  description: string;
  scenario?: ScenarioSummary;
  material?: MaterialIndex;
};

function resultState(result?: ResultSummary) {
  if (!result) return { text: 'Не начато', tone: 'new' };
  if (result.outcome === 'resolved') return { text: 'Пройдено', tone: 'passed' };
  if (result.outcome === 'review_required') return { text: 'Требуется разбор', tone: 'review' };
  if (result.outcome === 'timeout') return { text: 'Время вышло', tone: 'failed' };
  if (result.outcome === 'partial') return { text: 'Частично', tone: 'partial' };
  return { text: 'Завершено', tone: 'partial' };
}

export default function Learning() {
  const navigate = useNavigate();
  const { modules } = useAuth();
  const scenarios = useResource<ScenarioSummary[]>(
    () => (modules.play ? api.get('/scenarios') : Promise.resolve([])),
    [modules.play],
  );
  const sessions = useResource<SessionSummary[]>(
    () => (modules.play ? api.get('/sessions') : Promise.resolve([])),
    [modules.play],
  );
  const results = useResource<ResultSummary[]>(
    () => (modules.progress ? api.get('/results') : Promise.resolve([])),
    [modules.progress],
  );
  const materials = useResource<MaterialIndex[]>(
    () => (modules.materials ? api.get('/materials') : Promise.resolve([])),
    [modules.materials],
  );
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'passed' | 'retry'>('all');
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [starting, setStarting] = useState('');
  const [error, setError] = useState('');
  const keys = useRef<Record<string, string>>({});
  const detail = useResource<MaterialDetail | null>(
    () =>
      materialId
        ? api.get(`/scenarios/${encodeURIComponent(materialId)}/materials`)
        : Promise.resolve(null),
    [materialId],
  );

  const published = scenarios.value?.filter((item) => item.publishedVersion !== null) ?? [];
  const trainings = published;
  const routes = trainings.filter((item) => item.kind === 'mega');
  const trainingIds = new Set(trainings.map((item) => item.id));
  const references = (materials.value ?? []).filter((item) => !trainingIds.has(item.scenarioId));
  const latest = new Map<string, ResultSummary>();
  for (const result of results.value ?? [])
    if (!latest.has(result.scenarioId)) latest.set(result.scenarioId, result);
  const active = new Map<string, SessionSummary[]>();
  for (const session of sessions.value ?? []) {
    if (session.status !== 'active') continue;
    const attempts = active.get(session.scenarioId) ?? [];
    attempts.push(session);
    active.set(session.scenarioId, attempts);
  }
  const completed = new Set(
    (sessions.value ?? [])
      .filter((item) => item.status === 'completed')
      .map((item) => item.scenarioId),
  );
  const materialMap = new Map((materials.value ?? []).map((item) => [item.scenarioId, item]));
  const items: LearningItem[] = useMemo(() => {
    const entries: LearningItem[] = trainings
      .filter((item) => item.kind === 'scenario')
      .map((item) => ({
        id: item.id,
        title: item.title,
        description: scenarioDescription(item.description),
        scenario: item,
        material: materialMap.get(item.id),
      }));
    return entries;
  }, [scenarios.value, materials.value]);
  const visible = items.filter((item) => {
    const matches =
      !query ||
      `${item.title} ${item.description} ${item.material?.description ?? ''}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru'));
    const recent = latest.get(item.id);
    if (!matches) return false;
    if (filter === 'active') return active.has(item.id);
    if (filter === 'passed') return recent?.outcome === 'resolved';
    if (filter === 'retry') return !!recent && recent.outcome !== 'resolved';
    return true;
  });
  const visibleReferences = references.filter(
    (item) =>
      !query ||
      `${item.title} ${item.description}`
        .toLocaleLowerCase('ru')
        .includes(query.toLocaleLowerCase('ru')),
  );

  async function openSession(id: string, existing?: string) {
    if (
      starting ||
      !modules.play ||
      (published.find((item) => item.id === id)?.presentation === 'immersive' && !modules.immersive)
    )
      return;
    setStarting(id);
    setError('');
    try {
      const view = existing
        ? await api.get<SessionView>(`/sessions/${encodeURIComponent(existing)}`)
        : await api.post<SessionView>('/sessions', {
            scenarioId: id,
            requestId: keys.current[id] ?? (keys.current[id] = crypto.randomUUID()),
          });
      delete keys.current[id];
      if (view.status === 'completed') {
        await Promise.all([sessions.reload(), results.reload()]);
        if (modules.progress && view.resultId)
          navigate(`/results/${encodeURIComponent(view.resultId)}`);
        else setError('Попытка завершилась. Начните новую тренировку.');
        return;
      }
      navigate(
        `/${view.world && modules.immersive ? 'immersive' : 'play'}/${encodeURIComponent(view.id)}`,
      );
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setStarting('');
    }
  }

  function status(id: string) {
    if (active.has(id)) return { text: 'В процессе', tone: 'active' };
    if (latest.has(id)) return resultState(latest.get(id));
    if (completed.has(id)) return { text: 'Завершено', tone: 'partial' };
    return { text: 'Не начато', tone: 'new' };
  }

  function practiceControls(id: string, title: string) {
    const attempts = active.get(id) ?? [];
    const session = attempts[0];
    const result = latest.get(id);
    const immersiveUnavailable =
      published.find((item) => item.id === id)?.presentation === 'immersive' && !modules.immersive;
    return (
      <div className="learning-item-actions">
        {modules.play && (
          <button
            type="button"
            className="button primary"
            disabled={!!starting || immersiveUnavailable}
            onClick={() => void openSession(id, session?.id)}
          >
            {starting === id
              ? 'Открываем…'
              : session
                ? `Продолжить · ${dateTime(session.startedAt)}`
                : result
                  ? 'Повторить'
                  : 'Начать'}{' '}
            <ArrowRight size={16} />
          </button>
        )}
        {immersiveUnavailable && <span className="learning-unavailable">3D-модуль отключён</span>}
        {modules.play && session && (
          <button
            type="button"
            className="learning-text-link"
            disabled={!!starting || immersiveUnavailable}
            onClick={() => void openSession(id)}
          >
            Новая попытка
          </button>
        )}
        {attempts.length > 1 && (
          <details className="learning-other-attempts">
            <summary>Ещё активные попытки: {attempts.length - 1}</summary>
            {attempts.slice(1).map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={!!starting || immersiveUnavailable}
                onClick={() => void openSession(id, item.id)}
              >
                Продолжить от {dateTime(item.startedAt)}
              </button>
            ))}
          </details>
        )}
        {modules.progress && result && (
          <Link className="learning-text-link" to={`/results/${encodeURIComponent(result.id)}`}>
            Разбор последней попытки
          </Link>
        )}
        {modules.materials && materialMap.has(id) && (
          <button
            type="button"
            className="learning-text-link"
            aria-label={`${materialId === id ? 'Свернуть источники' : 'Открыть источники'}: ${title}`}
            aria-expanded={materialId === id}
            onClick={() => setMaterialId(materialId === id ? null : id)}
          >
            <BookOpen size={16} /> {materialId === id ? 'Свернуть источники' : 'Источники'}
          </button>
        )}
      </div>
    );
  }

  function materialPanel(id: string, title: string) {
    if (materialId !== id) return null;
    return (
      <div className="learning-material" role="region" aria-label={`Материал: ${title}`}>
        {detail.loading ? (
          <p role="status">Открываем материал…</p>
        ) : detail.error ? (
          <p role="alert">
            {detail.error} <button onClick={() => void detail.reload()}>Повторить</button>
          </p>
        ) : detail.value ? (
          <>
            {detail.value.excerpts.length ? (
              detail.value.excerpts.map((excerpt, index) => (
                <div key={`${excerpt.title}-${index}`}>
                  <h4>{excerpt.title}</h4>
                  <p>{excerpt.text}</p>
                  <small>
                    {excerpt.source.document} · {excerpt.source.section}
                  </small>
                </div>
              ))
            ) : (
              <p>Выдержек пока нет.</p>
            )}
            {detail.value.sources.length > 0 && (
              <p className="learning-source">
                Источники:{' '}
                {detail.value.sources
                  .map((source) => `${source.document} · ${source.section}`)
                  .join('; ')}
              </p>
            )}
          </>
        ) : null}
      </div>
    );
  }

  if (!modules.play && !modules.materials)
    return (
      <div className="status">
        <h1>Обучение недоступно</h1>
        <p>Разделы практики и материалов отключены.</p>
      </div>
    );
  return (
    <div className="page learning-hub">
      <header className="learning-intro">
        <span className="second-eyebrow">НА БОРТУ · ОБУЧЕНИЕ</span>
        <h1>Обучение</h1>
        <p>
          {modules.play
            ? 'Выберите тренировку, продолжите попытку или откройте разбор и источники по теме.'
            : 'Откройте материалы и источники по теме.'}
        </p>
      </header>
      {error && (
        <div className="inline-warning" role="alert">
          {error} <button onClick={() => setError('')}>Закрыть</button>
        </div>
      )}
      {routes.length > 0 && (
        <section className="learning-routes" aria-label="Маршруты курса">
          <h2>Маршруты курса</h2>
          <div className="learning-route-list">
            {routes.map((route) => (
              <article className="learning-featured" key={route.id}>
                <div>
                  <span className="second-eyebrow">КУРС</span>
                  <h3>{route.title.replace(/^Маршрут:\s*/i, '')}</h3>
                  <p>{scenarioDescription(route.description)}</p>
                  <span className={`learning-status ${status(route.id).tone}`}>
                    {status(route.id).text}
                  </span>
                  {latest.get(route.id) && (
                    <span className="learning-score">
                      Последняя попытка: {resultState(latest.get(route.id)).text} ·{' '}
                      {latest.get(route.id)!.ratingPoints}/100 баллов ·{' '}
                      {dateTime(latest.get(route.id)!.completedAt)}
                    </span>
                  )}
                  {materialPanel(route.id, route.title)}
                </div>
                {practiceControls(route.id, route.title)}
              </article>
            ))}
          </div>
        </section>
      )}
      {(scenarios.loading || materials.loading) && !scenarios.value && !materials.value ? (
        <div className="status" role="status">
          Загружаем обучение…
        </div>
      ) : null}
      {scenarios.error && modules.play && (
        <p className="inline-warning" role="alert">
          Практика: {scenarios.error}{' '}
          <button onClick={() => void scenarios.reload()}>Повторить</button>
        </p>
      )}
      {sessions.error && modules.play && (
        <p className="inline-warning" role="alert">
          Статусы попыток: {sessions.error}{' '}
          <button onClick={() => void sessions.reload()}>Повторить</button>
        </p>
      )}
      {results.error && modules.progress && (
        <p className="inline-warning" role="alert">
          Результаты: {results.error}{' '}
          <button onClick={() => void results.reload()}>Повторить</button>
        </p>
      )}
      {materials.error && modules.materials && (
        <p className="inline-warning" role="alert">
          Материалы: {materials.error}{' '}
          <button onClick={() => void materials.reload()}>Повторить</button>
        </p>
      )}
      <section className="learning-library" id="learning-library">
        <div className="learning-section-heading">
          <div>
            <span className="second-eyebrow">{modules.play ? 'ПРАКТИКА' : 'ИСТОЧНИКИ'}</span>
            <h2>{modules.play ? 'Тренировки' : 'Материалы'}</h2>
          </div>
          {modules.play && (
            <span>
              {visible.length} из {items.length}
            </span>
          )}
        </div>
        <div className="learning-toolbar">
          <label className="second-search-box">
            <Search size={18} />
            <input
              type="search"
              aria-label={modules.play ? 'Найти отдельную тренировку' : 'Найти материал'}
              placeholder={modules.play ? 'Найти тренировку' : 'Найти материал'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {modules.play && (
            <div className="learning-filters" role="group" aria-label="Статус обучения">
              {(
                [
                  { id: 'all', text: 'Все' },
                  { id: 'active', text: 'В процессе' },
                  { id: 'passed', text: 'Пройдено' },
                  { id: 'retry', text: 'Повторить' },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.text}
                </button>
              ))}
            </div>
          )}
        </div>
        {modules.play &&
          (visible.length ? (
            <div className="learning-list">
              {visible.map((item) => {
                const state = status(item.id),
                  result = latest.get(item.id);
                return (
                  <article className="learning-item" key={item.id}>
                    <div className="learning-item-main">
                      <div className="learning-item-top">
                        <span className="second-eyebrow">
                          {item.scenario?.kind === 'mega' ? 'МАРШРУТ' : 'СИТУАЦИЯ'}
                        </span>
                        <span className={`learning-status ${state.tone}`}>{state.text}</span>
                      </div>
                      <h3>{item.title}</h3>
                      {item.description && <p>{item.description}</p>}
                      <div className="learning-item-meta">
                        {result && (
                          <span>
                            Последняя попытка: {resultState(result).text} · {result.ratingPoints}
                            /100 баллов
                          </span>
                        )}
                        {active.has(item.id) && (
                          <span>
                            <Clock3 size={14} /> Активных попыток: {active.get(item.id)!.length}
                          </span>
                        )}
                        {item.material && (
                          <span>
                            <BookOpen size={14} /> Источники
                          </span>
                        )}
                        {item.scenario?.estimatedMinutes && (
                          <span>{item.scenario.estimatedMinutes} мин</span>
                        )}
                      </div>
                    </div>
                    {practiceControls(item.id, item.title)}
                    {materialPanel(item.id, item.title)}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="status">
              <h3>{items.length ? 'Тренировки не найдены' : 'Тренировок пока нет'}</h3>
              {items.length && (
                <button
                  onClick={() => {
                    setFilter('all');
                    setQuery('');
                  }}
                >
                  Сбросить фильтры
                </button>
              )}
            </div>
          ))}
      </section>
      {modules.materials && (visibleReferences.length > 0 || !modules.play) && (
        <section className="learning-references" aria-label="Справочник">
          <details open={!modules.play ? true : undefined}>
            <summary>
              Справочник <span>{visibleReferences.length} тем</span>
            </summary>
            <p>Источники и материалы по опубликованным темам.</p>
            {visibleReferences.length ? (
              <div className="learning-reference-list">
                {visibleReferences.map((item) => (
                  <article className="learning-reference" key={item.scenarioId}>
                    <h3>{item.title}</h3>
                    {item.description && <p>{item.description}</p>}
                    <button
                      type="button"
                      className="learning-text-link"
                      aria-expanded={materialId === item.scenarioId}
                      onClick={() =>
                        setMaterialId(materialId === item.scenarioId ? null : item.scenarioId)
                      }
                    >
                      <BookOpen size={16} />{' '}
                      {materialId === item.scenarioId ? 'Свернуть источники' : 'Открыть источники'}
                    </button>
                    {materialPanel(item.scenarioId, item.title)}
                  </article>
                ))}
              </div>
            ) : (
              <p>Материалов по этому запросу нет.</p>
            )}
          </details>
        </section>
      )}
    </div>
  );
}

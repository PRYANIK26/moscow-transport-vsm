import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { MaterialDetail, MaterialIndex } from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

export default function Materials() {
  const { modules } = useAuth();
  const catalog = useResource(() => api.get<MaterialIndex[]>('/materials'));
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<MaterialDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const list = useMemo(
    () =>
      catalog.value?.filter(
        (item) =>
          !query ||
          `${item.title} ${item.description}`
            .toLocaleLowerCase('ru')
            .includes(query.toLocaleLowerCase('ru')),
      ) ?? [],
    [catalog.value, query],
  );
  useEffect(() => {
    if (list.length && !list.some((item) => item.scenarioId === selectedId))
      setSelectedId(list[0].scenarioId);
  }, [list, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    void api
      .get<MaterialDetail>(`/scenarios/${encodeURIComponent(selectedId)}/materials`)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((failure) => {
        if (active) setDetailError(errorText(failure));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId, retryToken]);
  return (
    <div className="page materials-page second-materials">
      <div className="page-heading">
        <div>
          <span className="second-eyebrow">МАТЕРИАЛЫ КУРСА</span>
          <h1>Знания, которые помогают в пути</h1>
        </div>
        {catalog.value && <span className="second-materials-count">{catalog.value.length} учебных тем</span>}
      </div>
      <label className="materials-search">
        <Search size={19} />
        <input
          type="search"
          aria-label="Поиск по материалам"
          placeholder="Например: пересадка, плед, маломобильный пассажир…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {catalog.loading && !catalog.value ? (
        <div className="status" role="status">
          Загружаем материалы…
        </div>
      ) : catalog.error && !catalog.value ? (
        <div className="status status-error" role="alert">
          {catalog.error} <button onClick={() => void catalog.reload()}>Повторить</button>
        </div>
      ) : list.length ? (
        <div className="materials-layout">
          <nav className="materials-list" aria-label="Темы материалов">
            <div className="second-materials-list-heading"><BookOpen size={18} /> Все материалы <small>{list.length} тем</small></div>
            {list.map((item) => (
              <button
                type="button"
                className={item.scenarioId === selectedId ? 'active' : ''}
                key={item.scenarioId}
                onClick={() => setSelectedId(item.scenarioId)}
              >
                <span>{item.title}</span>
                {item.sources[0] && <small>{item.sources[0].section}</small>}
                <ArrowRight size={16} />
              </button>
            ))}
          </nav>
          <article className="materials-detail">
            {detailLoading ? (
              <p role="status">Открываем материал…</p>
            ) : detailError ? (
              <p role="alert">
                {detailError}{' '}
                <button onClick={() => setRetryToken((value) => value + 1)}>Повторить</button>
              </p>
            ) : detail ? (
              <>
                <span className="learning-eyebrow">МАТЕРИАЛ</span>
                <h2>{detail.title}</h2>
                {detail.excerpts.length ? (
                  <div className="materials-excerpts">
                    {detail.excerpts.map((excerpt, index) => (
                      <section key={`${excerpt.title}-${index}`}>
                        <h3>{excerpt.title}</h3>
                        <p>{excerpt.text}</p>
                        <small>
                          {excerpt.source.document} · {excerpt.source.section}
                        </small>
                      </section>
                    ))}
                  </div>
                ) : (
                  <p className="materials-caveat">Выдержек пока нет.</p>
                )}
                <h3>Источники сценария</h3>
                <ul className="materials-sources">
                  {detail.sources.map((source, index) => (
                    <li key={`${source.document}-${index}`}>
                      <strong>{source.document}</strong> · {source.section}
                    </li>
                  ))}
                </ul>
                {modules.play && (
                  <Link className="button primary" to="/scenarios">
                    Перейти к практике <ArrowRight size={16} />
                  </Link>
                )}
              </>
            ) : (
              <p>Выберите тему слева.</p>
            )}
          </article>
        </div>
      ) : (
        <div className="status">
          <h2>Материалы пока не найдены</h2>
          <p>{query ? 'Измените запрос.' : 'Тем пока нет.'}</p>
        </div>
      )}
    </div>
  );
}

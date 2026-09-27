import { useEffect } from 'react';
import { ArrowRight, Award, CalendarDays, Clock3, TrendingUp } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import {
  COMPETENCIES,
  COMPETENCY_LABELS,
  type ProgressSummary,
  type ResultSummary,
} from '@vsm/shared';
import { api } from '../../lib/api';
import { dateTime, number, outcomeLabel, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

export default function Progress() {
  const { modules } = useAuth();
  const location = useLocation();
  const recent = new URLSearchParams(location.search).has('recent');
  const summary = useResource(() => api.get<ProgressSummary>('/progress'));
  const results = useResource(() => api.get<ResultSummary[]>('/results'));
  useEffect(() => {
    if (!recent) return;
    const timers = [1200, 3200].map((ms) =>
      window.setTimeout(() => {
        void summary.reload();
        void results.reload();
      }, ms),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [recent, summary.reload, results.reload]);
  if (summary.loading && !summary.value)
    return (
      <div className="status" role="status">
        Загружаем прогресс…
      </div>
    );
  if (summary.error && !summary.value)
    return (
      <div className="status status-error" role="alert">
        <p>{summary.error}</p>
        <button onClick={() => void summary.reload()}>Повторить</button>
      </div>
    );
  const p = summary.value;
  if (!p) return null;
  const xpStart = (p.level - 1) * 100;
  const xpPct =
    p.nextLevelXp > xpStart
      ? Math.min(100, Math.max(0, ((p.xp - xpStart) / (p.nextLevelXp - xpStart)) * 100))
      : 100;
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Результаты</h1>
          <p>История тренировок, навыки и достижения</p>
        </div>
      </div>
      <section className="progress-hero">
        <div>
          <span className="hero-label">Уровень {p.level}</span>
          <h2>{p.levelTitle}</h2>
          <p>
            {number(p.xp)} XP · до следующего уровня {number(Math.max(0, p.nextLevelXp - p.xp))} XP
          </p>
          <div
            className="xp-track"
            role="progressbar"
            aria-label="Прогресс уровня"
            aria-valuenow={Math.round(xpPct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div style={{ width: `${xpPct}%` }} />
          </div>
        </div>
        <div className="progress-hero-side">
          <span>Рейтинговые баллы</span>
          <strong>{number(p.ratingPoints)}</strong>
          <small>Завершено тренировок: {number(p.completedSessions)}</small>
          {p.expiringPoints && (
            <small>
              Сгорят {number(p.expiringPoints.amount)} баллов ·{' '}
              {dateTime(p.expiringPoints.expiresAt)}
            </small>
          )}
        </div>
      </section>
      <div className="two-column">
        <section className="content-section">
          <div className="section-heading">
            <TrendingUp size={21} />
            <h2>Компетенции</h2>
          </div>
          <div className="competency-list">
            {COMPETENCIES.map((c) => (
              <div key={c} className="competency-row">
                <span>{COMPETENCY_LABELS[c]}</span>
                <strong>{number(p.competencies[c])}</strong>
              </div>
            ))}
          </div>
          <div className="recommendations">
            <h3>На что обратить внимание</h3>
            {p.recommendations.length > 0 ? (
              <ul>
                {p.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {p.completedSessions === 0
                  ? 'После первой тренировки здесь появятся рекомендации по вашим решениям.'
                  : 'По завершённым тренировкам дополнительных рекомендаций пока нет.'}
              </p>
            )}
          </div>
        </section>
        <section className="content-section">
          <div className="section-heading">
            <Award size={21} />
            <h2>Достижения</h2>
          </div>
          {p.achievements.length ? (
            <div className="achievement-list">
              {p.achievements.map((a) => (
                <article key={a.id}>
                  <div>
                    <strong>{a.title}</strong>
                    <p>{a.description}</p>
                    <small>
                      {a.earnedAt
                        ? `Получено ${dateTime(a.earnedAt)}`
                        : `В процессе: ${number(a.progress)} из ${number(a.target)}`}
                    </small>
                  </div>
                  <span className={'achievement-icon ' + (a.earnedAt ? 'earned' : '')}>
                    <Award size={20} />
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted">Достижения появятся после тренировок.</p>
          )}
        </section>
      </div>
      <section className="content-section">
        <div className="section-heading">
          <CalendarDays size={21} />
          <h2>Задания недели</h2>
        </div>
        {p.challenges.length ? (
          <div className="challenge-list">
            {p.challenges.map((c) => (
              <article key={c.id}>
                <div>
                  <h3>{c.title}</h3>
                  <p>{c.description}</p>
                  <small>
                    До {dateTime(c.endsAt)} · награда {number(c.reward)} XP
                  </small>
                </div>
                <div className="challenge-progress">
                  <strong>
                    {c.completed ? 'Выполнено' : `${number(c.progress)} / ${number(c.target)}`}
                  </strong>
                  <div
                    className="xp-track"
                    role="progressbar"
                    aria-label={c.title}
                    aria-valuenow={Math.min(c.progress, c.target)}
                    aria-valuemin={0}
                    aria-valuemax={c.target}
                  >
                    <div
                      style={{
                        width: `${Math.min(100, c.target ? (c.progress / c.target) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted">Активных заданий пока нет.</p>
        )}
      </section>
      <section className="content-section">
        <div className="section-heading">
          <Clock3 size={21} />
          <h2>История результатов</h2>
        </div>
        {results.loading && !results.value ? (
          <p className="muted">Загружаем историю…</p>
        ) : results.error && !results.value ? (
          <div className="minor-error">
            {results.error} <button onClick={() => void results.reload()}>Повторить</button>
          </div>
        ) : results.value?.length ? (
          <div className="result-list">
            {results.value.map((item) => (
              <Link
                key={item.id}
                to={`/results/${encodeURIComponent(item.id)}`}
                className="result-row"
              >
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {dateTime(item.completedAt)} · {outcomeLabel(item.outcome)}
                  </span>
                </div>
                <div>
                  <strong>+{number(item.xp)} XP</strong>
                  <ArrowRight size={17} />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">
            Завершённых тренировок пока нет.{' '}
            {modules.play && <Link to="/scenarios">Открыть сценарии</Link>}
          </p>
        )}
      </section>
    </div>
  );
}

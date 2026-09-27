import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, Medal, ArrowRight, RefreshCw } from 'lucide-react';
import type { LeaderboardMetric, LeaderboardResponse, TeamMember } from '@vsm/shared';
import { api } from '../../lib/api';
import { number, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

const SCOPES = [
  { id: 'company', label: 'Все проводники' },
  { id: 'depot', label: 'Депо' },
  { id: 'brigade', label: 'Бригада' },
] as const;
const METRICS: { id: LeaderboardMetric; label: string }[] = [
  { id: 'overall', label: 'Общий' },
  { id: 'service', label: 'Сервис' },
  { id: 'safety', label: 'Безопасность' },
];
function points(member: TeamMember | null, metric: LeaderboardMetric) {
  if (!member) return 0;
  return metric === 'service'
    ? member.servicePoints
    : metric === 'safety'
      ? member.safetyPoints
      : member.ratingPoints;
}
function metricLabel(metric: LeaderboardMetric) {
  return METRICS.find((item) => item.id === metric)!.label.toLowerCase();
}
function Breakdown({ member }: { member: TeamMember }) {
  return (
    <span className="ranking-breakdown">
      <span>Сервис: {number(member.servicePoints)}</span>
      <span>Безопасность: {number(member.safetyPoints)}</span>
    </span>
  );
}

export default function Leaderboard() {
  const { modules } = useAuth();
  const [scope, setScope] = useState<LeaderboardResponse['scope']>('company');
  const [metric, setMetric] = useState<LeaderboardMetric>('overall');
  const [offset, setOffset] = useState(0);
  const ranking = useResource(
    () =>
      api.get<LeaderboardResponse>(
        `/leaderboard?scope=${scope}&metric=${metric}&offset=${offset}&limit=25`,
      ),
    [scope, metric, offset],
  );
  const data = ranking.value;
  return (
    <div className="page leaderboard-page">
      <div className="page-heading">
        <div>
          <h1>Рейтинг</h1>
          <p>Результаты за последние 30 дней</p>
        </div>
        <button className="button" disabled={ranking.loading} onClick={() => void ranking.reload()}>
          <RefreshCw size={17} /> Обновить
        </button>
      </div>
      <div className="leaderboard-controls">
        <div className="segmented" role="group" aria-label="Направление рейтинга">
          {METRICS.map((item) => (
            <button
              key={item.id}
              aria-pressed={metric === item.id}
              onClick={() => {
                setMetric(item.id);
                setOffset(0);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Масштаб рейтинга">
          {SCOPES.map((item) => (
            <button
              key={item.id}
              aria-pressed={scope === item.id}
              onClick={() => {
                setScope(item.id);
                setOffset(0);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <details className="leaderboard-help">
        <summary>Как считается место</summary>
        <p>
          За 30 дней учитывается лучший результат каждого сценария по выбранной оценке. Сервис и
          безопасность выбирают лучший результат независимо. Одинаковые баллы дают общее место; XP в
          рейтинге не участвует.
        </p>
      </details>
      {ranking.loading && !data ? (
        <div className="status" role="status">
          Загружаем лидеров…
        </div>
      ) : ranking.error ? (
        <div className="status status-error" role="alert">
          <p>{ranking.error}</p>
          <button onClick={() => void ranking.reload()}>Повторить</button>
        </div>
      ) : (
        data && (
          <>
            <section className="leaderboard-personal" aria-label="Ваш результат">
              <div>
                <span>Ваше место · {metricLabel(data.metric)}</span>
                <strong>{data.me?.rank ? `№ ${data.me.rank}` : 'Пока без места'}</strong>
              </div>
              <div>
                <span>Баллы · {metricLabel(data.metric)}</span>
                <strong>{number(points(data.me, data.metric))}</strong>
              </div>
              {data.me && <Breakdown member={data.me} />}
              {!data.me?.rank && modules.play && (
                <Link className="button" to="/scenarios">
                  К тренировкам <ArrowRight size={17} />
                </Link>
              )}
            </section>
            {data.leaders.length > 0 ? (
              <section className="leaderboard-podium" aria-label="Лидеры">
                {data.leaders.map((member, index) => (
                  <article key={member.userId} className={`leader-card leader-card-${index + 1}`}>
                    <div className="leader-place">
                      <Medal size={25} /> <span>Место {member.rank}</span>
                    </div>
                    <h2>
                      {member.name}
                      {member.isCurrentUser && <span className="you-label">Вы</span>}
                    </h2>
                    <strong className="leader-points">
                      {number(points(member, data.metric))}{' '}
                      <small>баллов · {metricLabel(data.metric)}</small>
                    </strong>
                    <Breakdown member={member} />
                    <p>{member.countedScenarios} сценариев в зачёте</p>
                  </article>
                ))}
              </section>
            ) : (
              <section className="status">
                <Trophy size={32} />
                <h2>В этом направлении пока нет результатов</h2>
                {modules.play && <Link to="/scenarios">Открыть сценарии</Link>}
              </section>
            )}
            <div className="section-heading">
              <h2>Участники</h2>
              <span>{data.total}</span>
            </div>
            <div
              className="table-scroll desktop-rankings"
              tabIndex={0}
              role="region"
              aria-label="Участники рейтинга"
            >
              <table className="ranking-table">
                <caption>
                  {METRICS.find((item) => item.id === data.metric)?.label} ·{' '}
                  {SCOPES.find((item) => item.id === scope)?.label}
                </caption>
                <thead>
                  <tr>
                    <th>Место</th>
                    <th>Проводник</th>
                    <th>Баллы · {metricLabel(data.metric)}</th>
                    <th>Сервис</th>
                    <th>Безопасность</th>
                    <th>Сценариев</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((member) => (
                    <tr key={member.userId} className={member.isCurrentUser ? 'current-user' : ''}>
                      <td>{member.rank ?? '—'}</td>
                      <td>
                        <strong>{member.name}</strong>
                        {member.isCurrentUser && <span className="you-label">Вы</span>}
                      </td>
                      <td>{number(points(member, data.metric))}</td>
                      <td>{number(member.servicePoints)}</td>
                      <td>{number(member.safetyPoints)}</td>
                      <td>{member.countedScenarios}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mobile-rankings" aria-label="Участники рейтинга">
              {data.members.map((member) => (
                <article
                  key={member.userId}
                  className={`mobile-ranking-card ${member.isCurrentUser ? 'current-user' : ''}`}
                >
                  <div>
                    <strong>
                      {member.rank ? `№ ${member.rank}` : 'Без места'} · {member.name}
                    </strong>
                    {member.isCurrentUser && <span className="you-label">Вы</span>}
                  </div>
                  <span>
                    {number(points(member, data.metric))} баллов · {metricLabel(data.metric)}
                  </span>
                  <Breakdown member={member} />
                </article>
              ))}
            </div>
            {data.total > data.limit && (
              <nav className="leaderboard-pagination" aria-label="Страницы рейтинга">
                <button
                  className="button"
                  disabled={!offset || ranking.loading}
                  onClick={() => setOffset(Math.max(0, offset - data.limit))}
                >
                  Назад
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + data.limit, data.total)} из {data.total}
                </span>
                <button
                  className="button"
                  disabled={offset + data.limit >= data.total || ranking.loading}
                  onClick={() => setOffset(offset + data.limit)}
                >
                  Далее
                </button>
              </nav>
            )}
          </>
        )
      )}
    </div>
  );
}

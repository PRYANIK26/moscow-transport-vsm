import { useState } from 'react';
import { Users } from 'lucide-react';
import type { TeamResponse } from '@vsm/shared';
import { api } from '../../lib/api';
import { number, useResource } from '../../lib/ui';

type Scope = TeamResponse['scope'];
const SCOPES: { id: Scope; label: string }[] = [
  { id: 'brigade', label: 'Бригада' },
  { id: 'depot', label: 'Депо' },
  { id: 'company', label: 'Компания' },
];
export default function Team() {
  const [scope, setScope] = useState<Scope>('brigade');
  const [offset, setOffset] = useState(0);
  const team = useResource(
    () => api.get<TeamResponse>(`/team?scope=${scope}${offset ? `&offset=${offset}` : ''}`),
    [scope, offset],
  );
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Моя бригада</h1>
          <p>Сумма лучших результатов по сценариям за последние 30 дней</p>
        </div>
      </div>
      <section className="team-context">
        <Users size={24} />
        <div>
          <strong>{team.value?.brigade ?? 'Бригада'}</strong>
          <span>
            {team.value?.depot ?? 'Депо'} · {team.value?.company ?? 'Компания'}
          </span>
        </div>
      </section>
      <div className="segmented" role="group" aria-label="Масштаб рейтинга">
        {SCOPES.map((item) => (
          <button
            key={item.id}
            type="button"
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
      {team.loading && !team.value ? (
        <div className="status" role="status">
          Загружаем рейтинг…
        </div>
      ) : team.error && !team.value ? (
        <div className="status status-error" role="alert">
          <p>{team.error}</p>
          <button onClick={() => void team.reload()}>Повторить</button>
        </div>
      ) : team.value?.members.length ? (
        <>
          {team.value.me && !team.value.members.some((member) => member.isCurrentUser) && (
            <p className="leaderboard-personal">
              Ваше место: {team.value.me.rank ?? 'пока без места'} ·{' '}
              {number(team.value.me.ratingPoints)} баллов
            </p>
          )}
          <p className="table-hint">
            Прокрутите таблицу вправо, чтобы увидеть баллы и число тренировок.
          </p>
          <div
            className="table-scroll"
            role="region"
            aria-label="Рейтинг с горизонтальной прокруткой"
            tabIndex={0}
          >
            <table className="ranking-table">
              <caption>
                Рейтинг: {SCOPES.find((s) => s.id === scope)?.label.toLocaleLowerCase('ru')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Место</th>
                  <th scope="col">Сотрудник</th>
                  <th scope="col">Бригада / депо</th>
                  <th scope="col">Баллы</th>
                  <th scope="col">Тренировок</th>
                </tr>
              </thead>
              <tbody>
                {team.value.members.map((m) => (
                  <tr key={m.userId} className={m.isCurrentUser ? 'current-user' : ''}>
                    <td>{m.rank ?? '—'}</td>
                    <td>
                      <strong>{m.name}</strong>
                      {m.isCurrentUser && <span className="you-label">Вы</span>}
                    </td>
                    <td>
                      {m.brigade}
                      <small>{m.depot}</small>
                    </td>
                    <td>{number(m.ratingPoints)}</td>
                    <td>{number(m.completedSessions)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!!team.value.total && !!team.value.limit && team.value.total > team.value.limit && (
            <nav className="leaderboard-pagination" aria-label="Страницы бригады">
              <button
                className="button"
                disabled={!offset || team.loading}
                onClick={() => setOffset(Math.max(0, offset - team.value!.limit!))}
              >
                Назад
              </button>
              <span>
                {offset + 1}–{Math.min(offset + team.value.limit, team.value.total)} из{' '}
                {team.value.total}
              </span>
              <button
                className="button"
                disabled={offset + team.value.limit >= team.value.total || team.loading}
                onClick={() => setOffset(offset + team.value!.limit!)}
              >
                Далее
              </button>
            </nav>
          )}
        </>
      ) : (
        <div className="status">
          <Users size={28} />
          <h2>Пока нет участников рейтинга</h2>
          <p>Результаты появятся после завершённых тренировок.</p>
        </div>
      )}
    </div>
  );
}

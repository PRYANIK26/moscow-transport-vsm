import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { COMPETENCIES, COMPETENCY_LABELS, type ResultDetail } from '@vsm/shared';
import { api } from '../../lib/api';
import { dateTime, number, outcomeLabel, useResource } from '../../lib/ui';

export default function Result() {
  const { resultId } = useParams();
  const resource = useResource(
    () => api.get<ResultDetail>(`/results/${encodeURIComponent(resultId ?? '')}`),
    [resultId],
  );
  if (resource.loading && !resource.value)
    return (
      <div className="status" role="status">
        Загружаем разбор…
      </div>
    );
  if (resource.error && !resource.value)
    return (
      <div className="status status-error" role="alert">
        <p>{resource.error}</p>
        <button onClick={() => void resource.reload()}>Повторить</button>
      </div>
    );
  const result = resource.value;
  if (!result) return null;
  const needsReview = result.communicationStatus === 'review_required';
  const withheld = result.ratingEligible === false;
  const actionPoints = Math.max(0, Math.round((result.loyalty + result.safety) / 2));
  const skillPoints = COMPETENCIES.reduce(
    (sum, key) => sum + Math.max(0, result.competencies[key] || 0),
    0,
  );
  const expectedXp = 20 + skillPoints;
  const scoreMatches = !withheld && actionPoints === result.ratingPoints;
  const xpMatches = !withheld && expectedXp === result.xp;
  const status = needsReview
    ? 'ТРЕБУЕТСЯ РАЗБОР'
    : result.outcome === 'resolved'
      ? 'СЦЕНАРИЙ ПРОЙДЕН'
      : result.outcome === 'timeout'
        ? 'ВРЕМЯ ВЫШЛО'
        : result.outcome === 'partial'
          ? 'ЧАСТИЧНО'
          : 'ТРЕНИРОВКА ЗАВЕРШЕНА';
  const signed = (value: number) => (value > 0 ? `+${value}` : String(value));
  return (
    <div className="page result-page second-report">
      <Link className="back-link" to="/progress?recent=1">
        <ArrowLeft size={17} /> К результатам
      </Link>
      <section className="second-report-summary">
        <div className="second-report-intro">
          <span className="second-eyebrow">{status}</span>
          <h1>
            {needsReview ? 'Разбор необходим.' : outcomeLabel(result.outcome, result.outcomeTitle)}
          </h1>
          <p>
            {result.title} · {dateTime(result.completedAt)}
          </p>
          <div className="second-report-next">
            <Link className="button primary" to="/learning">
              К обучению <ArrowRight size={18} />
            </Link>
          </div>
        </div>
        <div className="second-report-score">
          <strong>{number(result.ratingPoints)}</strong>
          <p>Баллы попытки · +{number(result.xp)} XP</p>
          <small>
            {needsReview
              ? 'Рейтинговая награда до проверки не начислена'
              : 'Лучший результат учитывается в рейтинге за 30 дней'}
          </small>
        </div>
      </section>
      <section className="content-section learning-score-explain" aria-label="Как начислены баллы">
        <h2>Откуда баллы</h2>
        <div className="learning-score-formula">
          <div>
            <span>Лояльность</span>
            <strong>{result.loyalty}/100</strong>
          </div>
          <div>
            <span>Безопасность</span>
            <strong>{result.safety}/100</strong>
          </div>
          <div>
            <span>Баллы попытки</span>
            <strong>{result.ratingPoints}/100</strong>
          </div>
        </div>
        {withheld ? (
          <p>Оценки действий сохранены. Рейтинговые баллы и XP не начислены до разбора общения.</p>
        ) : scoreMatches ? (
          <p>
            Баллы попытки = ({result.loyalty} + {result.safety}) / 2, округлено:{' '}
            {result.ratingPoints}. В рейтинг за 30 дней идёт лучший результат этого сценария.
          </p>
        ) : (
          <p>
            Для этой попытки сохранено {result.ratingPoints} баллов. Формула текущей версии не
            применяется к старому результату.
          </p>
        )}
        {xpMatches && (
          <p>
            Опыт: 20 XP за завершение + {skillPoints} за навыки = {result.xp} XP.
          </p>
        )}
        <p>Ниже показано, какое решение изменило лояльность и безопасность и почему.</p>
      </section>
      <div className="second-report-grid">
        <section className="content-section second-feedback-card">
          <h2>Обратная связь</h2>
          {needsReview && (
            <div className="result-review" role="status">
              <h3>Требуется разбор общения</h3>
              <p>Награда и место в рейтинге до проверки не начислены.</p>
              {result.communicationReasons?.length ? (
                <ul>
                  {result.communicationReasons.map((reason, index) => (
                    <li key={index}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          {result.outcomeText && <p className="result-outcome-text">{result.outcomeText}</p>}
          {result.communicationStatus === 'observed' && (
            <p className="inline-warning">В диалоге есть наблюдения. Смотрите ниже.</p>
          )}
          {result.communicationStatus === 'not_assessed' && (
            <p className="inline-warning">Общение не оценивалось.</p>
          )}
          {result.ratingEligible !== false && (
            <p className="muted">
              Повторное прохождение прибавляет рейтинговые баллы только при улучшении результата.
            </p>
          )}
        </section>
        <section className="content-section second-feedback-card">
          <h2>Показатели</h2>
          <div className="second-report-stat">
            <span>Лояльность</span>
            <strong>{result.loyalty} / 100</strong>
          </div>
          <div className="second-report-stat">
            <span>Безопасность</span>
            <strong>{result.safety} / 100</strong>
          </div>
          <div className="second-report-stat">
            <span>Опыт</span>
            <strong>+{number(result.xp)} XP</strong>
          </div>
        </section>
      </div>
      {!!result.communicationObservations?.length && (
        <section className="content-section">
          <h2>Наблюдения по диалогу</h2>
          <ul className="recommendation-list">
            {result.communicationObservations.map((item, index) => (
              <li key={`${item.messageId}-${index}`}>
                <strong>
                  {item.kind === 'explicit_rudeness'
                    ? 'Грубость в отправленной реплике'
                    : 'Наблюдение AI'}
                </strong>
                <p>«{item.evidence}»</p>
                <small>Политика {item.policyVersion}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="two-column">
        <section className="content-section">
          <h2>Компетенции за тренировку</h2>
          <div className="competency-list">
            {COMPETENCIES.map((c) => (
              <div className="competency-row" key={c}>
                <span>{COMPETENCY_LABELS[c]}</span>
                <strong>{number(result.competencies[c])}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="content-section">
          <h2>Рекомендации</h2>
          {result.recommendations.length ? (
            <ul className="recommendation-list">
              {result.recommendations.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Дополнительных рекомендаций нет.</p>
          )}
        </section>
      </div>
      <section className="content-section">
        <h2>Решения по шагам</h2>
        {result.history.length ? (
          <ol className="report-history">
            {result.history.map((item, index) => (
              <li key={item.id}>
                <span className="history-index">{index + 1}</span>
                <div>
                  <span className="muted">
                    {item.scenarioTitle} · {dateTime(item.at)}
                  </span>
                  <h3>{item.situationTitle}</h3>
                  <p>{item.situationText}</p>
                  <div className="report-answer">
                    <strong>{item.kind === 'timeout' ? 'Время истекло' : item.answerText}</strong>
                  </div>
                  <p>
                    <strong>Последствие.</strong> {item.explanation}
                  </p>
                  {item.improvement && (
                    <p>
                      <strong>Как улучшить.</strong> {item.improvement}
                    </p>
                  )}
                  <div className="feedback-delta">
                    <span>
                      Лояльность {item.before.loyalty} <ArrowRight size={14} /> {item.after.loyalty}{' '}
                      ({signed(item.after.loyalty - item.before.loyalty)})
                    </span>
                    <span>
                      Безопасность {item.before.safety} <ArrowRight size={14} /> {item.after.safety}{' '}
                      ({signed(item.after.safety - item.before.safety)})
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Решений в этом прохождении не было.</p>
        )}
      </section>
    </div>
  );
}

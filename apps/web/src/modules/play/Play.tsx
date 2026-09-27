import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Clock3, RotateCcw } from 'lucide-react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import type { AnswerRequest, DecisionRecord, SessionView } from '@vsm/shared';
import { api, ApiError } from '../../lib/api';
import { notificationChanged } from '../../lib/notificationStatus';
import { dateTime, errorText, outcomeLabel, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';

type Pending = {
  kind: 'answer' | 'timeout';
  answerId?: string;
  expectedVersion: number;
  requestId: string;
};
function scale(label: string, value: number) {
  return (
    <div className="scale">
      <div className="scale-label">
        <span>{label}</span>
        <strong>{value} / 100</strong>
      </div>
      <div
        className="scale-track"
        role="meter"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}
function change(value?: number) {
  return value === undefined ? '—' : value > 0 ? `+${value}` : String(value);
}
function Feedback({ item }: { item: DecisionRecord }) {
  return (
    <details className="feedback" open>
      <summary>
        {item.kind === 'timeout' ? 'Время истекло' : 'Решение принято'} · {item.situationTitle}
      </summary>
      <p>
        <strong>Последствие.</strong> {item.explanation || 'Решение сохранено.'}
      </p>
      <div className="feedback-delta">
        <span>
          Лояльность {item.before.loyalty} → {item.after.loyalty} ({change(item.effects.loyalty)})
        </span>
        <span>
          Безопасность {item.before.safety} → {item.after.safety} ({change(item.effects.safety)})
        </span>
      </div>
      {item.improvement && (
        <p>
          <strong>Как улучшить.</strong> {item.improvement}
        </p>
      )}
    </details>
  );
}
export default function Play() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const { modules } = useAuth();
  const resource = useResource(
    () => api.get<SessionView>(`/sessions/${encodeURIComponent(sessionId ?? '')}`),
    [sessionId],
  );
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const pending = useRef<Pending | null>(null);
  const timeoutAttempt = useRef<string>('');
  const previousLength = useRef(0);
  const [newRecord, setNewRecord] = useState<DecisionRecord | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!resource.value) return;
    setClockOffset(Date.parse(resource.value.serverNow) - Date.now());
    if (resource.value.history.length > previousLength.current)
      setNewRecord(resource.value.history.at(-1) ?? null);
    previousLength.current = resource.value.history.length;
  }, [resource.value]);
  useEffect(() => {
    if (resource.value?.status !== 'completed' || !modules.notifications) return;
    notificationChanged();
    const timers = [1500, 4000].map((ms) => window.setTimeout(notificationChanged, ms));
    return () => timers.forEach(window.clearTimeout);
  }, [resource.value?.id, resource.value?.status, modules.notifications]);
  useEffect(() => {
    const view = resource.value;
    if (!view || view.status !== 'active' || !view.deadlineAt) {
      setRemaining(null);
      return;
    }
    const update = () =>
      setRemaining(
        Math.max(0, Math.ceil((Date.parse(view.deadlineAt!) - Date.now() - clockOffset) / 1000)),
      );
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [resource.value?.id, resource.value?.version, resource.value?.deadlineAt, clockOffset]);
  useEffect(() => {
    const view = resource.value;
    if (!view || view.status !== 'active' || !view.deadlineAt || remaining !== 0 || busy) return;
    const key = `${view.id}:${view.version}`;
    if (timeoutAttempt.current === key) return;
    timeoutAttempt.current = key;
    void submit({ kind: 'timeout', expectedVersion: view.version, requestId: crypto.randomUUID() });
  }, [remaining, resource.value?.id, resource.value?.version, busy]);
  async function submit(action: Pending) {
    const view = resource.value;
    if (!view || inFlight.current) return;
    inFlight.current = true;
    pending.current = action;
    setBusy(true);
    setActionError('');
    try {
      const updated =
        action.kind === 'answer'
          ? await api.post<SessionView>(`/sessions/${encodeURIComponent(view.id)}/answer`, {
              answerId: action.answerId,
              expectedVersion: action.expectedVersion,
              requestId: action.requestId,
            } as AnswerRequest)
          : await api.post<SessionView>(`/sessions/${encodeURIComponent(view.id)}/timeout`, {
              expectedVersion: action.expectedVersion,
              requestId: action.requestId,
            });
      pending.current = null;
      resource.setValue(updated);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        pending.current = null;
        setActionError('Состояние тренировки изменилось. Загрузили актуальный шаг.');
        await resource.reload();
      } else {
        errorText(e);
        setActionError('Не удалось подтвердить решение. Обновите шаг или повторите действие.');
        if (action.kind === 'timeout') {
          const current = await resource.reload();
          if (
            current &&
            (current.version !== action.expectedVersion || current.status === 'completed')
          )
            pending.current = null;
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function retry() {
    const action = pending.current;
    if (!action || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const current = await resource.reload();
    inFlight.current = false;
    setBusy(false);
    if (!current) return;
    if (current.version !== action.expectedVersion || current.status === 'completed') {
      pending.current = null;
      setActionError('Шаг уже обновлён. Показано актуальное состояние тренировки.');
      return;
    }
    void submit(action);
  }
  async function refreshStep() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const current = await resource.reload();
    inFlight.current = false;
    setBusy(false);
    if (!current) return;
    const action = pending.current;
    if (action && (current.version !== action.expectedVersion || current.status === 'completed')) {
      pending.current = null;
      setActionError('Шаг уже обновлён. Показано актуальное состояние тренировки.');
    } else if (!action) setActionError('');
  }
  function answer(id: string) {
    const view = resource.value;
    if (!view || busy || pending.current) return;
    void submit({
      kind: 'answer',
      answerId: id,
      expectedVersion: view.version,
      requestId: crypto.randomUUID(),
    });
  }
  async function restart() {
    const view = resource.value;
    if (!view || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const next = await api.post<SessionView>('/sessions', {
        scenarioId: view.scenarioId,
        requestId: crypto.randomUUID(),
      });
      navigate(`/play/${encodeURIComponent(next.id)}`);
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const view = resource.value;
  if (resource.loading && !view)
    return (
      <div className="status" role="status">
        Восстанавливаем тренировку…
      </div>
    );
  if (resource.error && !view)
    return (
      <div className="status status-error" role="alert">
        <p>{resource.error}</p>
        <button onClick={() => void resource.reload()}>Повторить</button>
      </div>
    );
  if (!view) return null;
  if (view.status === 'active' && view.world && modules.immersive)
    return <Navigate to={`/immersive/${encodeURIComponent(view.id)}`} replace />;
  return (
    <div className="page play-page">
      <Link className="back-link" to="/scenarios">
        <ArrowLeft size={17} /> К сценариям
      </Link>
      <div className="page-heading">
        <div>
          <h1>{view.title}</h1>
          <p>
            {view.currentScenarioTitle && view.currentScenarioTitle !== view.title
              ? `Сейчас: ${view.currentScenarioTitle}`
              : 'Практическая тренировка'}
          </p>
        </div>
        <span className={'state-pill ' + (view.status === 'completed' ? 'done' : '')}>
          {view.status === 'completed' ? 'Завершено' : 'В процессе'}
        </span>
      </div>
      <div className="score-panel">
        {scale('Лояльность пассажира', view.score.loyalty)}
        {scale('Безопасность', view.score.safety)}
      </div>
      {actionError && (
        <div className="inline-warning" role="alert">
          <AlertTriangle size={18} />
          <span>{actionError}</span>
          {pending.current && (
            <button onClick={() => void retry()} disabled={busy}>
              Повторить действие
            </button>
          )}
          <button onClick={() => void refreshStep()} disabled={busy}>
            Обновить шаг
          </button>
        </div>
      )}
      {view.status === 'completed' ? (
        <section className="completion">
          <h2>Тренировка завершена</h2>
          <p className="outcome">{outcomeLabel(view.outcome, view.outcomeTitle)}</p>
          <p>
            {view.outcomeText ||
              'Ваши решения и две итоговые шкалы сохранены. Разбор доступен в истории ниже.'}
          </p>
          <div className="button-row">
            {modules.progress && view.resultId && (
              <Link className="button primary" to={`/results/${encodeURIComponent(view.resultId)}`}>
                Полный разбор <ArrowRight size={17} />
              </Link>
            )}
            <button className="button" onClick={() => void restart()} disabled={busy}>
              <RotateCcw size={17} /> Пройти ещё раз
            </button>
            <Link className="button" to="/scenarios">
              К библиотеке
            </Link>
          </div>
        </section>
      ) : (
        <section className="decision-panel">
          <div className="decision-top">
            <span>Ситуация</span>
            {view.deadlineAt && (
              <div
                className={'timer ' + (remaining !== null && remaining <= 10 ? 'urgent' : '')}
                aria-live={remaining !== null && remaining <= 10 ? 'polite' : 'off'}
              >
                <Clock3 size={18} />
                {remaining === null
                  ? 'Время рассчитывается'
                  : remaining === 0
                    ? 'Время истекло'
                    : `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}
              </div>
            )}
          </div>
          <h2>{view.currentSituation?.title || 'Загружаем следующий шаг'}</h2>
          <p className="situation-text">{view.currentSituation?.text}</p>
          <div className="answers" aria-label="Варианты ответа">
            {view.answers.map((item, index) => (
              <button
                key={item.id}
                type="button"
                disabled={busy || remaining === 0 || !!pending.current}
                onClick={() => answer(item.id)}
              >
                <span>{index + 1}</span>
                <strong>{item.text}</strong>
                <ArrowRight size={20} />
              </button>
            ))}
          </div>
          {busy && (
            <p className="muted" role="status">
              Сохраняем решение…
            </p>
          )}
          {view.deadlineAt && (
            <p className="deadline-note">
              Время на решение — до {dateTime(view.deadlineAt)} по Москве. По истечении времени
              ответ считается пропущенным и применяются последствия таймаута.
            </p>
          )}
        </section>
      )}
      {newRecord && (
        <section className="recent-feedback">
          <h2>Последнее решение</h2>
          <Feedback key={newRecord.id} item={newRecord} />
        </section>
      )}
      <section className="history-section">
        <h2>История решений</h2>
        {view.history.length ? (
          <ol className="decision-history">
            {view.history.map((item, index) => (
              <li key={item.id}>
                <span className="history-index">{index + 1}</span>
                <div>
                  <strong>{item.situationTitle}</strong>
                  <p>{item.kind === 'timeout' ? 'Время истекло' : item.answerText}</p>
                  <span className="muted">{dateTime(item.at)}</span>
                  {item.id !== newRecord?.id && (
                    <details>
                      <summary>Разбор решения</summary>
                      <p>{item.explanation}</p>
                      <p>{item.improvement}</p>
                      <div className="feedback-delta">
                        <span>
                          Лояльность {item.before.loyalty} → {item.after.loyalty}
                        </span>
                        <span>
                          Безопасность {item.before.safety} → {item.after.safety}
                        </span>
                      </div>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">Здесь появятся принятые решения и их последствия.</p>
        )}
      </section>
    </div>
  );
}

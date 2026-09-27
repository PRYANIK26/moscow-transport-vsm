import {
  ArrowRight,
  Check,
  CheckCircle2,
  MapPin,
  Navigation,
  Package,
  Square,
} from 'lucide-react';
import type { AvailableWorldAction, SessionView } from '@vsm/shared';
import { actionTarget, scenarioDecisions } from './guidance';

type Props = {
  view: SessionView;
  selected: AvailableWorldAction | null;
  walkingTo: string | null;
  busy: boolean;
  nearPassenger: boolean;
  onSelect: (id: string) => void;
  onApproach: (id: string) => void;
  onStop: () => void;
  onAction: (kind: 'answer' | 'world-action', id: string) => void;
};

export function TaskGuide({
  view,
  selected,
  walkingTo,
  busy,
  nearPassenger,
  onSelect,
  onApproach,
  onStop,
  onAction,
}: Props) {
  const world = view.world;
  if (!world) return null;
  const target = actionTarget(world, selected);
  const decisions = scenarioDecisions(view);
  const last = decisions.at(-1);
  const distance = target
    ? Math.hypot(world.position.x - target.x, world.position.z - target.z)
    : 0;
  const reachable = selected ? selected.available : nearPassenger;
  const needsWalk = selected
    ? selected.reason === 'Подойдите к цели'
    : !nearPassenger;
  const answers = view.answers.filter(
    (answer) => !/отказаться/i.test(answer.text),
  );
  const percent = (z: number) =>
    Math.max(
      4,
      Math.min(
        96,
        ((z - (world.scene.trainClass === 'first' ? 6 : 1)) /
          (world.scene.trainClass === 'first' ? 21 : 24)) *
          100,
      ),
    );
  return (
    <section className="task-guide" aria-label="Навигатор задачи">
      <header>
        <span>
          {view.course
            ? `Ситуация ${view.course.current} / ${view.course.total}`
            : 'Тренировка'}
        </span>
        <span>
          Выполнено:{' '}
          {decisions.filter((item) => item.kind !== 'timeout').length}
        </span>
      </header>
      <h1>{view.currentScenarioTitle}</h1>
      {last && (
        <div className="task-result" role="status" key={last.id}>
          <CheckCircle2 size={19} />
          <div>
            <strong>
              {last.kind === 'timeout'
                ? 'Время вышло'
                : `Готово: ${last.answerText}`}
            </strong>
            <p>{last.explanation}</p>
          </div>
        </div>
      )}
      {view.commandFeedback && !view.commandFeedback.applied && (
        <p className="task-notice" role="status">
          {view.commandFeedback.text}
        </p>
      )}
      <div className="task-current">
        <small>
          ШАГ {decisions.length + 1} ·{' '}
          {last ? 'ЧТО ДЕЛАТЬ ДАЛЬШЕ' : 'ЧТО НУЖНО СДЕЛАТЬ'}
        </small>
        <h2>{selected?.text ?? 'Согласуйте решение с пассажиром'}</h2>
        {world.actions.length > 1 && (
          <label className="task-choice">
            Можно выбрать порядок
            <select
              aria-label="Выбрать следующее действие"
              value={selected?.id}
              onChange={(event) => onSelect(event.target.value)}
              disabled={busy || !!walkingTo}
            >
              {world.actions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.text}
                </option>
              ))}
            </select>
          </label>
        )}
        {target && (
          <>
            <div className="task-destination">
              <MapPin size={18} />
              <strong>{target.label}</strong>
              <span>{distance.toFixed(1)} м</span>
            </div>
            <div
              className="task-route"
              role="img"
              aria-label={`Схема вагона. Вы: ${world.position.z.toFixed(1)} м. Цель: ${target.label}, ${distance.toFixed(1)} м от вас.`}
            >
              <div className="task-route-track">
                <i
                  style={{
                    left: `${Math.min(percent(world.position.z), percent(target.z))}%`,
                    width: `${Math.abs(percent(world.position.z) - percent(target.z))}%`,
                  }}
                />
                <span
                  className="task-route-player"
                  style={{ left: `${percent(world.position.z)}%` }}
                />
                <span
                  className="task-route-target"
                  style={{ left: `${percent(target.z)}%` }}
                />
              </div>
              <div className="task-route-legend">
                <span>● Вы</span>
                <span>◆ Цель</span>
              </div>
            </div>
            {walkingTo ? (
              <div className="task-walking" role="status">
                <Navigation size={17} />
                <span>Идём к цели…</span>
                <button type="button" onClick={onStop}>
                  <Square size={13} /> Остановиться
                </button>
              </div>
            ) : (
              <p className={reachable ? 'task-arrived' : 'task-hint'}>
                {reachable
                  ? 'Вы у цели. Теперь выполните действие.'
                  : needsWalk
                    ? 'Сначала подойдите к отмеченной точке.'
                    : selected?.reason}
              </p>
            )}
            {!walkingTo && needsWalk && (
              <button
                className="task-primary"
                disabled={busy}
                onClick={() => onApproach(target.id)}
              >
                <Navigation size={18} /> Идти к цели <ArrowRight size={17} />
              </button>
            )}
          </>
        )}
        {selected && (
          <button
            className="task-primary"
            disabled={busy || !!walkingTo || !selected.available}
            onClick={() => onAction('world-action', selected.id)}
          >
            <Check size={18} />
            {busy ? 'Подтверждаем…' : `Выполнить: ${selected.text}`}
            <kbd>E</kbd>
          </button>
        )}
        {answers.map((answer) => (
          <button
            className="task-primary"
            key={answer.id}
            disabled={busy || !!walkingTo || !nearPassenger}
            onClick={() => onAction('answer', answer.id)}
          >
            {answer.text}
            <ArrowRight size={17} />
          </button>
        ))}
        {!selected && !answers.length && (
          <p className="task-hint">Откройте диалог и выберите решение.</p>
        )}
      </div>
      {!!world.inventory.length && (
        <p className="task-inventory">
          <Package size={17} /> У вас:{' '}
          {world.inventory
            .map(
              (id) =>
                world.scene.items.find((item) => item.id === id)?.label ?? id,
            )
            .join(', ')}
        </p>
      )}
      <details className="task-details">
        <summary>Условие и выполненные шаги</summary>
        <p>{view.currentSituation?.text}</p>
        <ol>
          {decisions.map((item) => (
            <li key={item.id}>
              <Check size={14} />
              {item.answerText}
            </li>
          ))}
        </ol>
        <p>{world.scene.objective}</p>
      </details>
    </section>
  );
}

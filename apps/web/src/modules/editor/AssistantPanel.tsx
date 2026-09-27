import { useEffect, useRef, useState } from 'react';
import type { ScenarioDefinition } from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText } from '../../lib/ui';

type Proposal = {
  summary: string;
  definition: ScenarioDefinition;
  baseRevision: number;
};
export function AssistantPanel({
  definition,
  revision,
  disabled,
  onApply,
}: {
  definition: ScenarioDefinition;
  revision: number;
  disabled: boolean;
  onApply: (value: ScenarioDefinition) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'scenario' | 'scene'>(
    definition.scene && definition.nodes.some((n) => n.type === 'worldAction')
      ? 'scene'
      : 'scenario',
  );
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [original, setOriginal] = useState<ScenarioDefinition | null>(null);
  const [undo, setUndo] = useState<ScenarioDefinition | null>(null);
  const applied = useRef<ScenarioDefinition | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api
      .get<{ available: boolean }>('/editor/assistant')
      .then((r) => {
        if (alive.current) setAvailable(r.available);
      })
      .catch((e) => {
        if (alive.current) setError(errorText(e));
      });
    return () => {
      alive.current = false;
    };
  }, []);
  const stale = original !== definition || proposal?.baseRevision !== revision;
  async function generate() {
    if (busy || disabled) return;
    setBusy(true);
    setError('');
    setProposal(null);
    setOriginal(definition);
    try {
      const result = await api.post<Proposal>(
        `/editor/scenarios/${definition.id}/assistant`,
        { prompt, mode, definition, expectedRevision: revision },
      );
      if (alive.current) setProposal(result);
    } catch (e) {
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const scene = proposal?.definition.scene;
  return (
    <details className="ed-assistant">
      <summary>
        ИИ-помощник сценариста <span>Описание → просмотр → применить</span>
      </summary>
      <div className="ed-assistant-body">
        <p>
          Опишите пассажира, его реплики, место, задачу и нужные взаимодействия.
          Помощник подготовит проверенный черновик. 3D-модели остаются прежними.
        </p>
        <label>
          Что изменить
          <select
            value={mode}
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
              setProposal(null);
            }}
          >
            <option value="scenario">
              Составить новый сюжет и последовательность действий
            </option>
            <option value="scene" disabled={!definition.scene}>
              Изменить пассажира и описание, сохранить граф действий
            </option>
          </select>
        </label>
        <label>
          Описание сценария
          <textarea
            rows={4}
            value={prompt}
            minLength={10}
            maxLength={6000}
            disabled={busy}
            onChange={(e) => {
              setPrompt(e.target.value);
              setProposal(null);
            }}
            placeholder="Пассажир у окна жалуется на холод. Сначала уточнить мнение соседей, затем связаться с бортинженером, взять плед и передать пассажиру. В конце проверить, стало ли комфортнее."
          />
        </label>
        {available === false && (
          <p role="status">
            ИИ пока не настроен. На сервере нужны YANDEX_API_KEY и
            YANDEX_FOLDER_ID.
          </p>
        )}
        <button
          type="button"
          className="ed-primary"
          disabled={
            busy || disabled || available !== true || prompt.trim().length < 10
          }
          onClick={() => void generate()}
        >
          {busy
            ? 'Готовим и проверяем предложение…'
            : proposal
              ? 'Уточнить предложение'
              : 'Подготовить черновик'}
        </button>
        {busy && (
          <p role="status">
            Текущий сценарий сохранит своё содержимое до применения предложения.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {proposal && (
          <section
            aria-label="Предварительный просмотр сценария"
            className="ed-assistant-preview"
          >
            <h3>{proposal.definition.title}</h3>
            <p>{proposal.summary}</p>
            <p>{proposal.definition.description}</p>
            {scene && (
              <>
                <p>
                  <strong>
                    {scene.passenger.name}, {scene.passenger.age}
                  </strong>{' '}
                  · направление {scene.passenger.facing ?? 0}°
                </p>
                <p>
                  Место:{' '}
                  {
                    scene.anchors.find((a) => a.id === scene.passenger.anchorId)
                      ?.label
                  }{' '}
                  · x=
                  {
                    scene.anchors.find((a) => a.id === scene.passenger.anchorId)
                      ?.x
                  }
                  , z=
                  {
                    scene.anchors.find((a) => a.id === scene.passenger.anchorId)
                      ?.z
                  }
                </p>
                <blockquote>{scene.passenger.initialLine}</blockquote>
                <p>Цель: {scene.objective}</p>
              </>
            )}
            <p>
              {mode === 'scene'
                ? 'Граф действий сохранён.'
                : `Новый сюжет заменит текущий граф. Время: ${proposal.definition.estimatedMinutes} мин.`}
            </p>
            <ol>
              {proposal.definition.nodes
                .filter((n) => n.type === 'worldAction')
                .map((n) => (
                  <li key={n.id}>
                    {n.type === 'worldAction' && (
                      <>
                        <strong>{n.text}</strong> →{' '}
                        {scene?.anchors.find((a) => a.id === n.targetId)?.label}
                        <p>{n.explanation}</p>
                      </>
                    )}
                  </li>
                ))}
            </ol>
            {stale && (
              <p role="alert">
                Сценарий изменился после запроса. Подготовьте предложение
                заново, чтобы сохранить новые правки.
              </p>
            )}
            <button
              type="button"
              className="ed-primary"
              disabled={stale || disabled || busy}
              onClick={() => {
                setUndo(definition);
                applied.current = proposal.definition;
                onApply(proposal.definition);
                setProposal(null);
              }}
            >
              Применить к черновику
            </button>
            <button
              type="button"
              className="ed-secondary"
              onClick={() => setProposal(null)}
            >
              Отклонить
            </button>
            <p>
              После применения сохраните черновик. Публикация выполняется
              отдельно.
            </p>
          </section>
        )}
        {undo && applied.current === definition && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              onApply(undo);
              setUndo(null);
            }}
          >
            Отменить применение ИИ
          </button>
        )}
      </div>
    </details>
  );
}

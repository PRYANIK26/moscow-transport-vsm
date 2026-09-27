import { memo, useEffect, useState } from 'react';
import {
  COMPETENCIES,
  COMPETENCY_LABELS,
  DEFAULT_DECISION_SECONDS,
  DEFAULT_TIMEOUT_EFFECTS,
} from '@vsm/shared';
import type {
  Competency,
  Condition,
  GraphEdge,
  GraphNode,
  Rule,
  ScenarioDefinition,
  ScenarioRecord,
  ScenarioSummary,
  SceneDefinition,
  TrainClass,
  WorldCommand,
} from '@vsm/shared';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { edgeSummary, finishOnTimeout, kindName, nodeName, uid } from './model';

type DefChange = (next: ScenarioDefinition) => void;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: string) => (value === '' ? 0 : Number(value));
const nextLocalId = (ids: string[], prefix: string) => {
  const used = new Set(ids);
  const numbers = ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  let next = Math.max(0, ...numbers) + 1;
  while (used.has(`${prefix}${next}`)) next++;
  return `${prefix}${next}`;
};

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="ed-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function MetadataPanel({ def, onChange }: { def: ScenarioDefinition; onChange: DefChange }) {
  const set = (patch: Partial<ScenarioDefinition>) => onChange({ ...def, ...patch });
  return (
    <div className="ed-fields">
      <h3>Параметры сценария</h3>
      <Field label="Название">
        <input value={def.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <Field label="Описание">
        <textarea
          rows={4}
          value={def.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
      <Field label="Класс обслуживания">
        <select
          value={def.serviceClass}
          disabled={!!def.scene}
          onChange={(e) =>
            set({ serviceClass: e.target.value as ScenarioDefinition['serviceClass'] })
          }
        >
          <option value="any">Любой</option>
          <option value="standard">Стандарт</option>
          <option value="comfort">Комфорт</option>
          <option value="business">Бизнес</option>
          <option value="first">Первый</option>
        </select>
        {def.scene && <small>Для 3D-сценария класс задаётся в настройках сцены ниже.</small>}
      </Field>
      <Field label="Сложность">
        <select
          value={def.difficulty}
          onChange={(e) => set({ difficulty: e.target.value as ScenarioDefinition['difficulty'] })}
        >
          <option value="beginner">Начальная</option>
          <option value="intermediate">Средняя</option>
          <option value="advanced">Высокая</option>
        </select>
      </Field>
      {def.kind === 'scenario' && <Field label="Отсчёт времени"><select value={def.timerMode ?? 'step'} onChange={(e) => set({ timerMode: e.target.value as 'scenario' | 'step' })}><option value="scenario">Общее время на сценарий</option><option value="step">Отдельное время на каждый шаг</option></select></Field>}
      <Field label={def.timerMode === 'scenario' ? 'Время на сценарий, минут' : 'Длительность, минут'}>
        <input
          type="number"
          min="1"
          value={def.estimatedMinutes}
          onChange={(e) => set({ estimatedMinutes: num(e.target.value) })}
        />
      </Field>
      <fieldset className="ed-fieldset">
        <legend>Компетенции</legend>
        {COMPETENCIES.map((c) => (
          <label className="ed-check" key={c}>
            <input
              type="checkbox"
              checked={def.competencies.includes(c)}
              onChange={(e) =>
                set({
                  competencies: e.target.checked
                    ? [...def.competencies, c]
                    : def.competencies.filter((v) => v !== c),
                })
              }
            />
            {COMPETENCY_LABELS[c]}
          </label>
        ))}
      </fieldset>
      <div className="ed-fieldset">
        <div className="ed-row">
          <strong>Источники</strong>
          <button
            type="button"
            className="ed-icon-button"
            title="Добавить источник"
            aria-label="Добавить источник"
            onClick={() => set({ sources: [...def.sources, { document: '', section: '' }] })}
          >
            <Plus size={18} />
          </button>
        </div>
        {def.sources.map((source, i) => (
          <div className="ed-source" key={i}>
            <Field label="Документ">
              <input
                value={source.document}
                onChange={(e) =>
                  set({
                    sources: def.sources.map((s, j) =>
                      j === i ? { ...s, document: e.target.value } : s,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Раздел">
              <input
                value={source.section}
                onChange={(e) =>
                  set({
                    sources: def.sources.map((s, j) =>
                      j === i ? { ...s, section: e.target.value } : s,
                    ),
                  })
                }
              />
            </Field>
            <Field label="Примечание">
              <input
                value={source.note ?? ''}
                onChange={(e) =>
                  set({
                    sources: def.sources.map((s, j) =>
                      j === i ? { ...s, note: e.target.value } : s,
                    ),
                  })
                }
              />
            </Field>
            <button
              type="button"
              className="ed-text-button"
              onClick={() => set({ sources: def.sources.filter((_, j) => j !== i) })}
            >
              <Trash2 size={16} /> Удалить источник
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const trainClasses: TrainClass[] = ['standard', 'comfort', 'business', 'first'];
const anchorKinds: SceneDefinition['anchors'][number]['kind'][] = [
  'passenger',
  'radio',
  'service',
  'seat',
  'exit',
];
const itemPrefabs: SceneDefinition['items'][number]['prefab'][] = [
  'blanket',
  'cleaning_kit',
  'bag',
  'marker',
];
const trainClassLabels: Record<TrainClass, string> = {
  standard: 'Стандарт',
  comfort: 'Комфорт',
  business: 'Бизнес',
  first: 'Первый класс',
};
const anchorKindLabels: Record<SceneDefinition['anchors'][number]['kind'], string> = {
  passenger: 'Пассажир',
  radio: 'Служебная связь',
  service: 'Сервисная зона',
  seat: 'Место',
  exit: 'Выход',
};
const itemPrefabLabels: Record<SceneDefinition['items'][number]['prefab'], string> = {
  blanket: 'Плед',
  cleaning_kit: 'Набор для уборки',
  bag: 'Багаж',
  marker: 'Маркер',
};
const commandLabels: Record<WorldCommand, string> = {
  inspect: 'Осмотреть',
  request_service: 'Запросить услугу',
  confirm_service: 'Подтвердить выполнение услуги',
  collect: 'Взять предмет',
  give: 'Передать предмет',
  follow_up: 'Уточнить результат',
  move_actor: 'Сопроводить пассажира',
};
export interface ImmersiveCatalog {
  trainClasses: TrainClass[];
  anchorKinds: SceneDefinition['anchors'][number]['kind'][];
  itemPrefabs: SceneDefinition['items'][number]['prefab'][];
  commands: WorldCommand[];
}

export function ScenePanel({
  def,
  onChange,
  catalog,
}: {
  def: ScenarioDefinition;
  onChange: DefChange;
  catalog: ImmersiveCatalog | null;
}) {
  const scene = def.scene;
  if (!scene) return null;
  const set = (patch: Partial<SceneDefinition>) =>
    onChange({
      ...def,
      ...(patch.trainClass ? { serviceClass: patch.trainClass } : {}),
      scene: { ...scene, ...patch },
    });
  const allowed = <T extends string>(values: T[], current: T) =>
    values.includes(current) ? values : [current, ...values];
  const classes = allowed(catalog?.trainClasses ?? trainClasses, scene.trainClass);
  const kinds = catalog?.anchorKinds ?? anchorKinds;
  const prefabs = catalog?.itemPrefabs ?? itemPrefabs;
  return (
    <div className="ed-fields">
      <h3>Сцена вагона</h3>
      <p className="ed-hint">Положение точек задаётся координатами X/Z в метрах.</p>
      <Field label="Класс вагона">
        <select
          value={scene.trainClass}
          onChange={(e) => set({ trainClass: e.target.value as TrainClass })}
        >
          {classes.map((value) => (
            <option key={value} value={value}>
              {trainClassLabels[value]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Старт X">
        <input
          type="number"
          step="0.01"
          value={scene.spawn.x}
          onChange={(e) => set({ spawn: { ...scene.spawn, x: num(e.target.value) } })}
        />
      </Field>
      <Field label="Старт Z">
        <input
          type="number"
          step="0.01"
          value={scene.spawn.z}
          onChange={(e) => set({ spawn: { ...scene.spawn, z: num(e.target.value) } })}
        />
      </Field>
      <Field label="Вступление"><textarea value={scene.brief ?? ''} onChange={(e) => set({brief: e.target.value})} /></Field>
      <Field label="Цель"><textarea value={scene.objective ?? ''} onChange={(e) => set({objective: e.target.value})} /></Field>
      <Field label="Правила (по одному на строку)"><textarea value={(scene.rules ?? []).join('\n')} onChange={(e) => set({rules: e.target.value.split('\n')})} /></Field>
      <fieldset className="ed-fieldset">
        <legend>Пассажир</legend>
        {(['name', 'description', 'initialLine', 'anchorId'] as const).map((key) => (
          <Field
            key={key}
            label={
              {
                name: 'Имя',
                description: 'Описание',
                initialLine: 'Первая реплика',
                anchorId: 'ID якоря пассажира',
              }[key]
            }
          >
            <input
              value={scene.passenger[key]}
              onChange={(e) => set({ passenger: { ...scene.passenger, [key]: e.target.value } })}
            />
          </Field>
        ))}
        <Field label="Направление пассажира (градусы)"><input type="number" min="0" max="360" value={scene.passenger.facing ?? 0} onChange={e => set({passenger:{...scene.passenger,facing:num(e.target.value)}})} /></Field>
        <Field label="Возраст">
          <input
            type="number"
            min="1"
            max="120"
            value={scene.passenger.age}
            onChange={(e) => set({ passenger: { ...scene.passenger, age: num(e.target.value) } })}
          />
        </Field>
      </fieldset>
      <fieldset className="ed-fieldset">
        <legend>Якоря</legend>
        {scene.anchors.map((anchor, i) => {
          const update = (patch: Partial<typeof anchor>) =>
            set({
              anchors: scene.anchors.map((item, j) => (j === i ? { ...item, ...patch } : item)),
            });
          return (
            <div className="ed-source" key={i}>
              <Field label="ID">
                <input value={anchor.id} onChange={(e) => update({ id: e.target.value })} />
              </Field>
              <Field label="Подпись">
                <input value={anchor.label} onChange={(e) => update({ label: e.target.value })} />
              </Field>
              <Field label="Тип">
                <select
                  value={anchor.kind}
                  onChange={(e) => update({ kind: e.target.value as typeof anchor.kind })}
                >
                  {allowed(kinds, anchor.kind).map((value) => (
                    <option key={value} value={value}>
                      {anchorKindLabels[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="X">
                <input
                  type="number"
                  step="0.01"
                  value={anchor.x}
                  onChange={(e) => update({ x: num(e.target.value) })}
                />
              </Field>
              <Field label="Z">
                <input
                  type="number"
                  step="0.01"
                  value={anchor.z}
                  onChange={(e) => update({ z: num(e.target.value) })}
                />
              </Field>
              <Field label="Радиус, м">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={anchor.radius}
                  onChange={(e) => update({ radius: num(e.target.value) })}
                />
              </Field>
              <button
                type="button"
                className="ed-text-button ed-danger"
                onClick={() => set({ anchors: scene.anchors.filter((_, j) => j !== i) })}
              >
                <Trash2 size={16} /> Удалить якорь
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="ed-secondary ed-full"
          onClick={() =>
            set({
              anchors: [
                ...scene.anchors,
                {
                  id: nextLocalId(scene.anchors.map((anchor) => anchor.id), 'anchor-'),
                  label: 'Новая точка',
                  kind: 'seat',
                  x: 0,
                  z: 7.11,
                  radius: 1.8,
                },
              ],
            })
          }
        >
          <Plus size={16} /> Добавить якорь
        </button>
      </fieldset>
      <fieldset className="ed-fieldset">
        <legend>Предметы</legend>
        {scene.items.map((item, i) => {
          const update = (patch: Partial<typeof item>) =>
            set({
              items: scene.items.map((value, j) => (j === i ? { ...value, ...patch } : value)),
            });
          return (
            <div className="ed-source" key={i}>
              <Field label="ID">
                <input value={item.id} onChange={(e) => update({ id: e.target.value })} />
              </Field>
              <Field label="Подпись">
                <input value={item.label} onChange={(e) => update({ label: e.target.value })} />
              </Field>
              <Field label="Якорь">
                <select
                  value={item.anchorId}
                  onChange={(e) => update({ anchorId: e.target.value })}
                >
                  {scene.anchors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} · {a.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Тип">
                <select
                  value={item.prefab}
                  onChange={(e) => update({ prefab: e.target.value as typeof item.prefab })}
                >
                  {allowed(prefabs, item.prefab).map((value) => (
                    <option key={value} value={value}>
                      {itemPrefabLabels[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                className="ed-text-button ed-danger"
                onClick={() => set({ items: scene.items.filter((_, j) => j !== i) })}
              >
                <Trash2 size={16} /> Удалить предмет
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="ed-secondary ed-full"
          disabled={!scene.anchors.length || !prefabs.length}
          onClick={() =>
            set({
              items: [
                ...scene.items,
                {
                  id: nextLocalId(scene.items.map((item) => item.id), 'item-'),
                  label: 'Новый предмет',
                  anchorId: scene.anchors[0].id,
                  prefab: prefabs[0],
                },
              ],
            })
          }
        >
          <Plus size={16} /> Добавить предмет
        </button>
      </fieldset>
      {!catalog && (
        <p className="ed-hint">
          Список действий пока недоступен. Черновик можно сохранить и проверить позже.
        </p>
      )}
    </div>
  );
}

export function NodePanel({
  def,
  node,
  ordinary,
  catalog,
  onChange,
  onDelete,
}: {
  def: ScenarioDefinition;
  node: GraphNode;
  ordinary: ScenarioSummary[];
  catalog: ImmersiveCatalog | null;
  onChange: DefChange;
  onDelete: () => void;
}) {
  const set = (patch: Partial<GraphNode>) =>
    onChange({
      ...def,
      nodes: def.nodes.map((n) => (n.id === node.id ? ({ ...n, ...patch } as GraphNode) : n)),
    });
  const setEffects = (patch: Record<string, unknown>) => {
    if (node.type !== 'answer' && node.type !== 'situation' && node.type !== 'worldAction') return;
    const effects =
      node.type === 'situation' ? (node.timeoutEffects ?? DEFAULT_TIMEOUT_EFFECTS) : node.effects;
    set({
      [node.type === 'situation' ? 'timeoutEffects' : 'effects']: { ...effects, ...patch },
    } as Partial<GraphNode>);
  };
  const effects =
    node.type === 'answer' || node.type === 'worldAction'
      ? node.effects
      : node.type === 'situation'
        ? (node.timeoutEffects ?? DEFAULT_TIMEOUT_EFFECTS)
        : {};
  return (
    <div className="ed-fields">
      <div className="ed-row">
        <h3>{kindName(node.type)}</h3>
        <button type="button" className="ed-text-button ed-danger" onClick={onDelete}>
          <Trash2 size={16} /> Удалить
        </button>
      </div>
      <p className="ed-muted ed-id">ID: {node.id}</p>
      <Field label="Заголовок">
        <input value={node.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      {node.type !== 'scenario' && (
        <Field label="Текст">
          <textarea
            rows={5}
            value={text(node.text)}
            onChange={(e) => set({ text: e.target.value })}
          />
        </Field>
      )}
      {node.type === 'situation' && (
        <>
          {def.timerMode !== 'scenario' && <Field label="Таймер шага, секунд">
            <input
              type="number"
              min="1"
              max="3600"
              value={node.timerSeconds ?? DEFAULT_DECISION_SECONDS}
              onChange={(e) => set({ timerSeconds: num(e.target.value) })}
            />
          </Field>}
          {def.timerMode === 'scenario' && <p>На весь сценарий: {def.estimatedMinutes} мин. Когда время закончится, попытка завершится.</p>}
          {def.timerMode !== 'scenario' && <><label className="ed-check ed-timeout-choice">
            <input
              type="checkbox"
              checked={finishOnTimeout(node, def)}
              onChange={(event) => {
                const finish = event.target.checked;
                const timeoutEdges = def.edges.filter(
                  (edge) => edge.source === node.id && edge.trigger === 'timeout',
                );
                if (
                  finish &&
                  timeoutEdges.length &&
                  !window.confirm(
                    'Удалить связь таймаута и завершать сценарий по истечении времени?',
                  )
                )
                  return;
                onChange({
                  ...def,
                  nodes: def.nodes.map((item) =>
                    item.id === node.id ? { ...item, finishOnTimeout: finish } : item,
                  ),
                  edges: finish
                    ? def.edges.filter((edge) => !timeoutEdges.includes(edge))
                    : def.edges,
                });
              }}
            />
            Завершить сценарий по таймауту
          </label>
          <p className="ed-hint">
            Таймер работает на каждом шаге. При выключенном флажке добавьте одну связь «Таймаут» к
            завершению; без неё проверка не пропустит граф. В маршруте исход timeout может вести
            дальше по условиям.
          </p></>}
          <EffectsFields effects={effects} onChange={setEffects} />
          <Field label="Разбор при таймауте">
            <textarea
              rows={3}
              value={node.timeoutExplanation ?? ''}
              onChange={(e) => set({ timeoutExplanation: e.target.value })}
            />
          </Field>
        </>
      )}
      {node.type === 'answer' && (
        <>
          <EffectsFields effects={effects} onChange={setEffects} />
          <Field label="Почему так">
            <textarea
              rows={3}
              value={node.explanation}
              onChange={(e) => set({ explanation: e.target.value })}
            />
          </Field>
          <Field label="Как улучшить">
            <textarea
              rows={3}
              value={node.improvement}
              onChange={(e) => set({ improvement: e.target.value })}
            />
          </Field>
        </>
      )}
      {node.type === 'worldAction' && def.scene && (
        <>
          <Field
            label="Команда"
            hint="Проводник выполняет это действие у выбранной точки вагона."
          >
            <select
              value={node.command}
              disabled={!catalog}
              onChange={(e) => set({ command: e.target.value as WorldCommand })}
            >
              {(!catalog || !catalog.commands.includes(node.command)) && (
                <option value={node.command}>{commandLabels[node.command]} · сохранено в черновике</option>
              )}
              {catalog?.commands.map((value) => (
                <option key={value} value={value}>
                  {commandLabels[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Цель">
            <select value={node.targetId} onChange={(e) => set({ targetId: e.target.value })}>
              {!def.scene.anchors.some((a) => a.id === node.targetId) && (
                <option value={node.targetId}>{node.targetId || 'Выберите цель'}</option>
              )}
              {def.scene.anchors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Предмет">
            <select
              value={node.itemId ?? ''}
              onChange={(e) => set({ itemId: e.target.value || undefined })}
            >
              <option value="">Без предмета</option>
              {def.scene.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.id}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Требует ранее выполненные действия"
            hint="Укажите ID предшествующих действий через запятую."
          >
            <input
              value={(node.requires ?? []).join(', ')}
              onChange={(e) =>
                set({
                  requires: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <EffectsFields effects={effects} onChange={setEffects} />
          <Field label="Почему так">
            <textarea
              rows={3}
              value={node.explanation}
              onChange={(e) => set({ explanation: e.target.value })}
            />
          </Field>
          <Field label="Как улучшить">
            <textarea
              rows={3}
              value={node.improvement}
              onChange={(e) => set({ improvement: e.target.value })}
            />
          </Field>
        </>
      )}
      {node.type === 'end' && (
        <Field
          label="Код исхода"
          hint="Например: resolved, escalated. Его можно проверить в переходах маршрута."
        >
          <input value={node.outcome} onChange={(e) => set({ outcome: e.target.value })} />
        </Field>
      )}
      {node.type === 'scenario' && (
        <Field label="Вложенный сценарий">
          <select
            value={node.scenarioId}
            onChange={(e) =>
              set({
                scenarioId: e.target.value,
                title: ordinary.find((s) => s.id === e.target.value)?.title ?? node.title,
              })
            }
          >
            <option value="">Выберите сценарий</option>
            {ordinary
              .filter((s) => def.childScenarioIds.includes(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
          </select>
        </Field>
      )}
      <button
        type="button"
        className="ed-secondary ed-full"
        disabled={def.startNodeId === node.id}
        onClick={() => onChange({ ...def, startNodeId: node.id })}
      >
        {def.startNodeId === node.id ? 'Стартовый узел' : 'Сделать стартовым'}
      </button>
    </div>
  );
}

function EffectsFields({
  effects,
  onChange,
}: {
  effects: {
    loyalty?: number;
    safety?: number;
    competencies?: Partial<Record<Competency, number>>;
  };
  onChange: (patch: Record<string, unknown>) => void;
}) {
  return (
    <fieldset className="ed-fieldset">
      <legend>Последствия</legend>
      <Field label="Лояльность, шкала">
        <input
          type="number"
          value={effects.loyalty ?? 0}
          onChange={(e) => onChange({ loyalty: num(e.target.value) })}
        />
      </Field>
      <Field label="Безопасность, шкала">
        <input
          type="number"
          value={effects.safety ?? 0}
          onChange={(e) => onChange({ safety: num(e.target.value) })}
        />
      </Field>
      {COMPETENCIES.map((c) => (
        <Field key={c} label={`Баллы: ${COMPETENCY_LABELS[c]}`}>
          <input
            type="number"
            value={effects.competencies?.[c] ?? 0}
            onChange={(e) =>
              onChange({ competencies: { ...effects.competencies, [c]: num(e.target.value) } })
            }
          />
        </Field>
      ))}
    </fieldset>
  );
}

const fieldOptions: Rule['field'][] = ['loyalty', 'safety', 'competency', 'choice', 'outcome'];
const fieldLabels: Record<Rule['field'], string> = {
  loyalty: 'Лояльность',
  safety: 'Безопасность',
  competency: 'Компетенция',
  choice: 'Сделанный выбор',
  outcome: 'Исход сценария',
};
const initialRule = (field: Rule['field']): Rule =>
  field === 'choice'
    ? { field, op: 'includes', value: '' }
    : field === 'outcome'
      ? { field, op: 'eq', key: '', value: '' }
      : field === 'competency'
        ? { field, op: 'gte', key: 'communication', value: 0 }
        : { field, op: 'gte', value: 0 };

export function EdgePanel({
  def,
  edge,
  onChange,
  onDelete,
}: {
  def: ScenarioDefinition;
  edge: GraphEdge;
  onChange: DefChange;
  onDelete: () => void;
}) {
  const [choiceOptions, setChoiceOptions] = useState<{ value: string; label: string }[]>([]);
  const childKey = def.childScenarioIds.join('|');
  useEffect(() => {
    if (def.kind === 'scenario') {
      setChoiceOptions(
        def.nodes
          .filter((n) => n.type === 'answer' || n.type === 'worldAction')
          .map((n) => ({ value: `${def.id}:${n.id}`, label: `${def.title} · ${n.title}` })),
      );
      return;
    }
    let active = true;
    Promise.all(
      def.childScenarioIds.map((id) => api.get<ScenarioRecord>(`/editor/scenarios/${id}`)),
    )
      .then((records) => {
        if (active)
          setChoiceOptions(
            records.flatMap((record) =>
              record.definition.nodes
                .filter((n) => n.type === 'answer' || n.type === 'worldAction')
                .map((n) => ({
                  value: `${record.definition.id}:${n.id}`,
                  label: `${record.definition.title} · ${n.title}`,
                })),
            ),
          );
      })
      .catch(() => {
        if (active) setChoiceOptions([]);
      });
    return () => {
      active = false;
    };
  }, [def.id, def.kind, childKey]);
  const set = (patch: Partial<GraphEdge>) =>
    onChange({ ...def, edges: def.edges.map((e) => (e.id === edge.id ? { ...e, ...patch } : e)) });
  const changeEndpointOrTrigger = (patch: Partial<GraphEdge>) => {
    const changed = { ...edge, ...patch };
    const source = def.nodes.find((node) => node.id === changed.source);
    if (changed.trigger === 'timeout') {
      if (source?.type !== 'situation') {
        window.alert('Связь таймаута может начинаться только от ситуации.');
        return;
      }
      if (changed.condition) {
        window.alert(
          'Уберите условия связи перед переводом в таймаут: таймаутная связь должна быть безусловной.',
        );
        return;
      }
      const otherTimeout = def.edges.some(
        (item) =>
          item.id !== edge.id && item.source === changed.source && item.trigger === 'timeout',
      );
      if (otherTimeout) {
        window.alert('У ситуации уже есть связь таймаута. Допускается только одна.');
        return;
      }
      if (
        finishOnTimeout(source, def) &&
        !window.confirm(
          'Для связи таймаута нужно выключить «Завершить сценарий по таймауту». Переключить режим?',
        )
      )
        return;
    }
    const edges = def.edges.map((item) => (item.id === edge.id ? changed : item));
    const nodes = def.nodes.map((node) => {
      if (node.type !== 'situation') return node;
      if (changed.trigger === 'timeout' && node.id === changed.source)
        return { ...node, finishOnTimeout: false };
      if (
        edge.trigger === 'timeout' &&
        node.id === edge.source &&
        !edges.some((item) => item.source === node.id && item.trigger === 'timeout')
      )
        return { ...node, finishOnTimeout: true };
      return node;
    });
    onChange({ ...def, edges, nodes });
  };
  const condition = edge.condition;
  const setCondition = (next?: Condition) => set({ condition: next });
  const setRule = (index: number, next: Rule) =>
    setCondition({
      mode: condition?.mode ?? 'all',
      rules: (condition?.rules ?? []).map((r, i) => (i === index ? next : r)),
    });
  return (
    <div className="ed-fields">
      <div className="ed-row">
        <h3>Переход</h3>
        <button type="button" className="ed-text-button ed-danger" onClick={onDelete}>
          <Trash2 size={16} /> Удалить
        </button>
      </div>
      <p className="ed-hint">
        Если условия заданы, движок проверяет их по приоритету. Связь без условий служит запасным
        переходом.
      </p>
      <Field label="Откуда">
        <select
          value={edge.source}
          onChange={(e) => changeEndpointOrTrigger({ source: e.target.value })}
        >
          {def.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {nodeName(n)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Куда">
        <select value={edge.target} onChange={(e) => set({ target: e.target.value })}>
          {def.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {nodeName(n)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Триггер">
        <select
          value={edge.trigger ?? 'default'}
          onChange={(e) =>
            changeEndpointOrTrigger({ trigger: e.target.value as GraphEdge['trigger'] })
          }
        >
          <option value="default">Обычный</option>
          {def.kind === 'scenario' && <option value="timeout">Таймаут</option>}
        </select>
      </Field>
      <Field label="Подпись">
        <input value={edge.label ?? ''} onChange={(e) => set({ label: e.target.value })} />
      </Field>
      <Field label="Приоритет" hint="Меньшее число проверяется первым.">
        <input
          type="number"
          value={edge.priority ?? 0}
          onChange={(e) => set({ priority: num(e.target.value) })}
        />
      </Field>
      <fieldset className="ed-fieldset">
        <legend>Условия перехода</legend>
        <label className="ed-check">
          <input
            type="checkbox"
            checked={!!condition}
            onChange={(e) =>
              setCondition(
                e.target.checked ? { mode: 'all', rules: [initialRule('safety')] } : undefined,
              )
            }
          />{' '}
          Добавить условия
        </label>
        {condition && (
          <>
            <Field label="Как объединять правила">
              <select
                value={condition.mode}
                onChange={(e) =>
                  setCondition({ ...condition, mode: e.target.value as Condition['mode'] })
                }
              >
                <option value="all">Все правила</option>
                <option value="any">Любое правило</option>
              </select>
            </Field>
            {condition.rules.map((rule, i) => (
              <div className="ed-rule" key={i}>
                <div className="ed-row">
                  <strong>Правило {i + 1}</strong>
                  <button
                    type="button"
                    className="ed-icon-button"
                    aria-label={`Удалить правило ${i + 1}`}
                    onClick={() =>
                      setCondition({
                        ...condition,
                        rules: condition.rules.filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <Field label="Поле">
                  <select
                    value={rule.field}
                    onChange={(e) => setRule(i, initialRule(e.target.value as Rule['field']))}
                  >
                    {fieldOptions.map((f) => (
                      <option key={f} value={f}>
                        {fieldLabels[f]}
                      </option>
                    ))}
                  </select>
                </Field>
                {(rule.field === 'competency' || rule.field === 'outcome') && (
                  <Field label={rule.field === 'outcome' ? 'ID дочернего сценария' : 'Компетенция'}>
                    {rule.field === 'competency' ? (
                      <select
                        value={rule.key}
                        onChange={(e) => setRule(i, { ...rule, key: e.target.value as Competency })}
                      >
                        {COMPETENCIES.map((c) => (
                          <option key={c} value={c}>
                            {COMPETENCY_LABELS[c]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <select
                        value={rule.key}
                        onChange={(e) => setRule(i, { ...rule, key: e.target.value })}
                      >
                        <option value="">Выберите сценарий</option>
                        {def.childScenarioIds.map((id) => (
                          <option key={id} value={id}>
                            {def.nodes.find((n) => n.type === 'scenario' && n.scenarioId === id)
                              ?.title ?? id}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
                <Field label="Оператор">
                  <select
                    value={rule.op}
                    onChange={(e) => setRule(i, { ...rule, op: e.target.value } as Rule)}
                  >
                    {(rule.field === 'choice'
                      ? [
                          ['includes', 'Сделан'],
                          ['excludes', 'Не сделан'],
                        ]
                      : rule.field === 'outcome'
                        ? [
                            ['eq', 'Равен'],
                            ['neq', 'Не равен'],
                          ]
                        : rule.field === 'competency'
                          ? [
                              ['gte', 'Не меньше'],
                              ['lte', 'Не больше'],
                            ]
                          : [
                              ['gte', 'Не меньше'],
                              ['lte', 'Не больше'],
                              ['eq', 'Равен'],
                            ]
                    ).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={
                    rule.field === 'choice'
                      ? 'Сценарий:ответ/действие'
                      : rule.field === 'outcome'
                        ? 'Код исхода'
                        : 'Значение'
                  }
                  hint={
                    rule.field === 'choice'
                      ? 'Выберите ответ или действие из списка либо укажите scenarioId:nodeId. ID узла виден в его параметрах.'
                      : undefined
                  }
                >
                  <input
                    list={rule.field === 'choice' ? `ed-choices-${edge.id}-${i}` : undefined}
                    type={rule.field === 'choice' || rule.field === 'outcome' ? 'text' : 'number'}
                    value={rule.value}
                    onChange={(e) =>
                      setRule(i, {
                        ...rule,
                        value:
                          rule.field === 'choice' || rule.field === 'outcome'
                            ? e.target.value
                            : num(e.target.value),
                      } as Rule)
                    }
                  />
                  {rule.field === 'choice' && (
                    <datalist id={`ed-choices-${edge.id}-${i}`}>
                      {choiceOptions.map((option) => (
                        <option key={option.value} value={option.value} label={option.label} />
                      ))}
                    </datalist>
                  )}
                </Field>
              </div>
            ))}
            <button
              type="button"
              className="ed-secondary ed-full"
              onClick={() =>
                setCondition({ ...condition, rules: [...condition.rules, initialRule('safety')] })
              }
            >
              <Plus size={16} /> Добавить правило
            </button>
          </>
        )}
      </fieldset>
      <p className="ed-muted">{edgeSummary(edge)}</p>
    </div>
  );
}

export const ConnectPanel = memo(
  function ConnectPanel({
    def,
    onConnect,
  }: {
    def: ScenarioDefinition;
    onConnect: (source: string, target: string) => void;
  }) {
    const source = def.nodes[0]?.id ?? '';
    return (
      <form
        className="ed-connect"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          onConnect(String(data.get('source')), String(data.get('target')));
        }}
      >
        <h3>Связать узлы</h3>
        <p className="ed-hint">Доступно и без перетаскивания: выберите начало и конец.</p>
        <Field label="Откуда">
          <select name="source" defaultValue={source} key={`source-${source}`}>
            {def.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {nodeName(n)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Куда">
          <select name="target" defaultValue={def.nodes[1]?.id ?? source} key={`target-${source}`}>
            {def.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {nodeName(n)}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="ed-primary ed-full" disabled={def.nodes.length < 2}>
          Создать связь
        </button>
      </form>
    );
  },
  (before, after) =>
    before.onConnect === after.onConnect &&
    before.def.nodes.length === after.def.nodes.length &&
    before.def.nodes.every(
      (node, index) =>
        node.id === after.def.nodes[index].id && node.title === after.def.nodes[index].title,
    ),
);

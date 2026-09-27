import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock3, Headphones, MapPin, Menu, Volume2, VolumeX, X } from 'lucide-react';
import { Link, Navigate, useParams, useNavigate } from 'react-router-dom';
import type { AnswerRequest, AvailableWorldAction, SessionView, WorldActionRequest, WorldMoveRequest, WorldPoint } from '@vsm/shared';
import { api, ApiError } from '../../lib/api';
import { notificationChanged } from '../../lib/notificationStatus';
import { dateTime, errorText, outcomeLabel, useResource } from '../../lib/ui';
import { useAuth } from '../../shell/App';
import { Scene, type SceneHandle } from './Scene';
import { Dialogue, type DialogueHandle, type VoiceState } from './Dialogue';
import type { GraphicsQuality } from './Rendering';
import { TaskGuide } from './TaskGuide';
import { actionTarget, selectedAction, situationMessage } from './guidance';
import './immersive.css';
import './original-dialogue.css';
import './guided-game.css';

type Pending = { kind: 'answer' | 'world-action' | 'timeout'; id?: string; expectedVersion: number; requestId: string };

function distance(a: WorldPoint, b: WorldPoint) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export default function Immersive() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const nextRequest = useRef<string | null>(null);
  const nextBusy = useRef(false);
  const { modules } = useAuth();
  const resource = useResource(() => api.get<SessionView>(`/sessions/${encodeURIComponent(sessionId ?? '')}`), [sessionId]);
  const continuation = useResource<{courseId:string;position:number;total:number;next:{id:string;title:string}|null} | null>(() => resource.value?.status === 'completed' && !resource.value.course ? api.get(`/scenarios/${resource.value.scenarioId}/next`) : Promise.resolve(null), [resource.value?.status, resource.value?.scenarioId]);
  const viewRef = useRef<SessionView | null>(null);
  const sceneHandle = useRef<SceneHandle | null>(null);
  const desired = useRef<WorldPoint | null>(null);
  const movePromise = useRef<Promise<void> | null>(null);
  const moveAcknowledgedAt = useRef(0);
  const commandBusy = useRef(false);
  const preparing = useRef(false);
  const dialogueBusyRef = useRef(false);
  const [dialogueBusy, setDialogueBusy] = useState(false);
  const pending = useRef<Pending | null>(null);
  const timeoutAttempt = useRef('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [walkingTo, setWalkingTo] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelKind, setPanelKind] = useState<'menu' | 'conversation'>('menu');
  const dialogueHandle = useRef<DialogueHandle | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>({recording:false,busy:false,seconds:0,error:'',sound:true,speaking:false,loading:false});
  const [enteredKey, setEnteredKey] = useState('');
  const [sceneReady, setSceneReady] = useState(false);
  const sceneKey = resource.value ? `${resource.value.id}:${resource.value.currentScenarioId}` : '';
  useEffect(() => {
    setSceneReady(false);
    setPanelOpen(false);
    setSelectedId(null);
    setWalkingTo(null);
    desired.current = null;
    moveAcknowledgedAt.current = performance.now();
    pending.current = null;
    setError('');
    try { setEnteredKey(sessionStorage.getItem(`entered:${sceneKey}`) ? sceneKey : ''); }
    catch { setEnteredKey(''); }
  }, [sceneKey]);
  const [quality, setQuality] = useState<GraphicsQuality>(() => {
    try {
      const saved = localStorage.getItem('vsm-immersive-quality');
      return saved === 'low' || saved === 'high' ? saved : 'auto';
    } catch { return 'auto'; }
  });
  useEffect(() => {
    try { localStorage.setItem('vsm-immersive-quality', quality); } catch { /* Storage is optional. */ }
  }, [quality]);
  const [resetToken, setResetToken] = useState(0);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 599px) and (orientation: portrait)').matches);


  useEffect(() => {
    const query = window.matchMedia('(max-width: 599px) and (orientation: portrait)');
    const changed = () => setCompact(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const value = resource.value;
    if (!value) return;
    if (!viewRef.current || value.id !== viewRef.current.id || value.version >= viewRef.current.version) {
      viewRef.current = value;
      setOffset(Date.parse(value.serverNow) - Date.now());
    }
  }, [resource.value]);
  useEffect(() => {
    const value = resource.value;
    if (value?.status !== 'completed' || !modules.notifications) return;
    notificationChanged();
  }, [resource.value?.id, resource.value?.status, modules.notifications]);
  useEffect(() => {
    const value = resource.value;
    if (!value || value.status !== 'active' || !value.deadlineAt || value.world?.dialogue?.status === 'pending') { setRemaining(null); return; }
    const update = () => setRemaining(Math.max(0, Math.ceil((Date.parse(value.deadlineAt!) - Date.now() - offset) / 1000)));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [resource.value?.id, resource.value?.version, resource.value?.deadlineAt, offset]);
  useEffect(() => {
    if (resource.value?.world?.dialogue?.status !== 'pending') return;
    const timer = window.setInterval(() => { void resource.reload(); }, 1500);
    return () => window.clearInterval(timer);
  }, [resource.value?.id, resource.value?.world?.dialogue?.status, resource.reload]);

  useEffect(() => {
    const next = resource.value;
    if (next?.commandFeedback?.actionId && !next.commandFeedback.applied) setSelectedId(next.commandFeedback.actionId);
  }, [resource.value?.commandFeedback]);
  const observedDecision = useRef<string | undefined>(undefined);
  useEffect(() => {
    const next = resource.value;
    if (!next) return;
    const key = `${next.id}:${next.history.at(-1)?.id ?? 'start'}`;
    if (observedDecision.current && observedDecision.current !== key) {
      desired.current = null;
      sceneHandle.current?.stop();
      setSelectedId(null);
      setPanelOpen(next.status === 'completed');
    }
    observedDecision.current = key;
  }, [resource.value?.id, resource.value?.history.at(-1)?.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      sceneHandle.current?.stop();
      setPanelOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  function apply(next: SessionView) {
    if (viewRef.current?.id === next.id && next.version < viewRef.current.version) return;
    viewRef.current = next;
    resource.setValue(next);
    setOffset(Date.parse(next.serverNow) - Date.now());
    if (next.status === 'completed') { desired.current = null; sceneHandle.current?.stop(); setPanelOpen(true); }
  }
  async function reload() {
    const next = await resource.reload();
    if (next) apply(next);
    return next;
  }
  function onDialogueBusy(value: boolean) {
    dialogueBusyRef.current = value;
    setDialogueBusy(value);
    if (value) sceneHandle.current?.stop();
  }
  async function prepareDialogue() {
    sceneHandle.current?.stop();
    if (movePromise.current) await movePromise.current;
    await flushMove(true);
    return viewRef.current;
  }
  function onMove(position: WorldPoint) { desired.current = position; }
  async function flushMove(force = false) {
    const current = viewRef.current;
    const point = desired.current;
    if (!point || !current?.world || current.status !== 'active' || current.world.dialogue?.status === 'pending' || movePromise.current || commandBusy.current || (!force && (preparing.current || dialogueBusyRef.current)) || pending.current || remaining === 0) return;
    if (distance(point, current.world.position) < 0.08) return;
    const wait = distance(point, current.world.position) / 2.3 * 1000 - (performance.now() - moveAcknowledgedAt.current);
    if (wait > 0 && !force) return;
    const payload: WorldMoveRequest = { position: point, expectedVersion: current.version, requestId: crypto.randomUUID() };
    const task = (async () => {
      try {
        if (wait > 0) await new Promise(resolve => window.setTimeout(resolve, wait));
        const next = await api.post<SessionView>(`/sessions/${encodeURIComponent(current.id)}/world-move`, payload);
        moveAcknowledgedAt.current = performance.now();
        if (desired.current === point) desired.current = null;
        apply(next);
      } catch (failure) {
        desired.current = null;
        sceneHandle.current?.stop();
        setError(failure instanceof ApiError && failure.status === 409
          ? 'Позиция изменилась. Загружено состояние с сервера.'
          : `Не удалось сохранить перемещение: ${errorText(failure)}`);
        await reload();
        desired.current = null;
        moveAcknowledgedAt.current = performance.now();
        setResetToken((value) => value + 1);
      }
    })();
    movePromise.current = task;
    await task;
    movePromise.current = null;
  }
  const flushMoveRef = useRef(flushMove);
  flushMoveRef.current = flushMove;
  useEffect(() => {
    const timer = window.setInterval(() => { void flushMoveRef.current(); }, 400);
    return () => window.clearInterval(timer);
  }, []);

  async function submit(action: Pending) {
    if (commandBusy.current) return;
    commandBusy.current = true;
    setBusy(true);
    setError('');
    sceneHandle.current?.stop();
    try {
      if (movePromise.current) await movePromise.current;
      desired.current = null;
      const current = viewRef.current;
      if (!current || current.status !== 'active') { pending.current = null; return; }
      // Preserve the same id and version for an uncertain network outcome.
      const payload = { ...action, expectedVersion: action.expectedVersion };
      let next: SessionView;
      if (action.kind === 'answer') {
        next = await api.post<SessionView>(`/sessions/${encodeURIComponent(current.id)}/answer`, {
          answerId: action.id, expectedVersion: payload.expectedVersion, requestId: payload.requestId,
        } as AnswerRequest);
      } else if (action.kind === 'world-action') {
        next = await api.post<SessionView>(`/sessions/${encodeURIComponent(current.id)}/world-action`, {
          actionId: action.id, expectedVersion: payload.expectedVersion, requestId: payload.requestId,
        } as WorldActionRequest);
      } else {
        next = await api.post<SessionView>(`/sessions/${encodeURIComponent(current.id)}/timeout`, {
          expectedVersion: payload.expectedVersion, requestId: payload.requestId,
        });
      }
      pending.current = null;
      apply(next);
      if (action.kind !== 'timeout' && next.status !== 'completed') setPanelOpen(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        pending.current = null;
        setError('Шаг изменился. Загружено актуальное состояние.');
        await reload();
      } else {
        setError(`Не удалось подтвердить действие: ${errorText(failure)}. Обновите шаг или повторите запрос.`);
      }
    } finally {
      commandBusy.current = false;
      setBusy(false);
    }
  }
  async function act(kind: Pending['kind'], id?: string) {
    const current = viewRef.current;
    if (!current || current.world?.dialogue?.status === 'pending' || commandBusy.current || preparing.current || dialogueBusyRef.current || pending.current || remaining === 0) return;
    preparing.current = true;
    setBusy(true);
    sceneHandle.current?.stop();
    if (movePromise.current) await movePromise.current;
    await flushMove(true);
    const updated = viewRef.current;
    if (!updated || updated.status !== 'active') { preparing.current = false; setBusy(false); return; }
    const action: Pending = { kind, id, expectedVersion: updated.version, requestId: crypto.randomUUID() };
    pending.current = action;
    preparing.current = false;
    void submit(action);
  }
  async function retry() {
    const action = pending.current;
    if (!action || commandBusy.current || preparing.current) return;
    preparing.current = true;
    setBusy(true);
    try {
      const current = await reload();
      if (!current) return;
      if (current.version !== action.expectedVersion || current.status !== 'active') {
        pending.current = null;
        setError('Шаг уже изменился. Показано актуальное состояние.');
        return;
      }
      await submit(action);
    } finally {
      preparing.current = false;
      setBusy(false);
    }
  }
  async function refreshStep() {
    if (commandBusy.current) return;
    commandBusy.current = true;
    setBusy(true);
    try {
      const current = await reload();
      if (current) setError('');
      const action = pending.current;
      if (current && action && (current.version !== action.expectedVersion || current.status !== 'active')) {
        pending.current = null;
        setError('Шаг уже изменился. Показано актуальное состояние.');
      }
    } finally {
      commandBusy.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    const current = resource.value;
    if (!current || current.status !== 'active' || current.world?.dialogue?.status === 'pending' || !current.deadlineAt || remaining !== 0 || commandBusy.current) return;
    const key = `${current.id}:${current.version}`;
    if (timeoutAttempt.current === key || pending.current) return;
    timeoutAttempt.current = key;
    sceneHandle.current?.stop();
    desired.current = null;
    const action: Pending = { kind: 'timeout', expectedVersion: current.version, requestId: crypto.randomUUID() };
    pending.current = action;
    void submit(action);
  }, [remaining, resource.value?.id, resource.value?.version]);

  const view = resource.value;
  if (resource.loading && !view) return <div className="status" role="status">Восстанавливаем тренировку…</div>;
  if (resource.error && !view) return <div className="status status-error" role="alert"><p>{resource.error}</p><button onClick={() => void reload()}>Повторить</button></div>;
  if (!view) return null;
  if (view.status === 'active' && !view.world) return <Navigate to={`/play/${encodeURIComponent(view.id)}`} replace />;
  const world = view.world;
  const actions = world?.actions ?? [];
  const selected = selectedAction(world, selectedId);
  const passengerAnchor = world?.scene.anchors.find(a => a.id === (world.actorAnchorId ?? world.scene.passenger.anchorId));
  const nearPassenger = !!world && !!passengerAnchor && distance(world.position, passengerAnchor) <= passengerAnchor.radius;
  const entered = enteredKey === sceneKey;
  const target = world ? actionTarget(world, selected) : null;
  const interactionTargetId = entered ? target?.id : passengerAnchor?.id;
  const metres = target && world ? Math.round(distance(world.position, target) * 10) / 10 : null;
  const complete = view.status === 'completed';
  const dialoguePending = world?.dialogue?.status === 'pending';
  const message = situationMessage(view);
  function approach(id?: string) {
    if (!id) return;
    setPanelOpen(false);
    sceneHandle.current?.goTo(id);
  }
  function enterScene() {
    setEnteredKey(sceneKey);
    try { sessionStorage.setItem(`entered:${sceneKey}`, 'yes'); } catch { /* Optional preference. */ }
    approach(target?.id ?? passengerAnchor?.id);
  }
  async function startNext(scenarioId: string) {
    if (nextBusy.current) return;
    nextBusy.current = true; setBusy(true); setError('');
    try {
      const result = await api.post<SessionView>('/sessions',{scenarioId,requestId:nextRequest.current ?? (nextRequest.current = crypto.randomUUID())});
      nextRequest.current = null;
      navigate(`/${result.world ? 'immersive' : 'play'}/${encodeURIComponent(result.id)}`);
    } catch(failure) {setError(errorText(failure));}
    finally {nextBusy.current = false;setBusy(false);}
  }
  function openConversation() { sceneHandle.current?.stop(); setPanelKind('conversation'); setPanelOpen(true); }
  function interact() {
    if (!entered || busy || dialogueBusy || dialoguePending || pending.current || remaining === 0) return;
    if (selected?.available) void act('world-action', selected.id);
    else if (selected?.reason === 'Подойдите к цели') approach(target?.id);
    else openConversation();
  }
  return <div className={`immersive-page guided-game${compact ? ' phone-portrait' : ''}${complete ? ' training-complete' : ''}`}>
    <div className="immersive-top">
      <Link to="/scenarios" className="immersive-back"><ArrowLeft size={17} /> Каталог</Link>
      <span>{view.course ? `Курс · ${complete ? view.course.completed : view.course.current} из ${view.course.total}` : 'ВСМ · Практика в вагоне'}</span>
      <div className="immersive-top-controls">
        {!complete && <div className={'immersive-timer immersive-timer-always' + (remaining !== null && remaining <= 10 ? ' urgent' : '')}><Clock3 size={19} />{dialoguePending ? 'Таймер на паузе' : remaining === null ? 'Время рассчитывается' : remaining === 0 ? 'Время истекло' : `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2,'0')}`}</div>}
        <label>Качество <select value={quality} onChange={(event) => setQuality(event.target.value as GraphicsQuality)}><option value="auto">Авто</option><option value="high">Высокое</option><option value="low">Экономное</option></select></label>
        <button type="button" onClick={() => dialogueHandle.current?.toggleSound()} aria-label={voiceState.sound ? 'Выключить голос пассажира' : 'Включить голос пассажира'}>{voiceState.sound ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
        <button type="button" className="immersive-menu-button" aria-label={panelOpen ? 'Закрыть панель тренировки' : 'Открыть панель тренировки'} aria-expanded={panelOpen} onClick={() => { setPanelKind('menu'); sceneHandle.current?.stop(); setPanelOpen((value) => !value); }}>{panelOpen ? <X size={18} /> : <Menu size={18} />}<span>{panelOpen ? 'Закрыть' : 'Меню'}</span></button>
      </div>
    </div>
    <div className="immersive-layout">
      <section className="immersive-stage" aria-label="Сцена вагона">
        {world && !compact && !complete ? <Scene key={`${view.id}:${view.currentScenarioId}`} sceneKey={`${view.id}:${view.currentScenarioId}`} resetToken={resetToken} world={world} scenarioTitle={view.title} targetId={interactionTargetId ?? null} quality={quality} speaking={voiceState.speaking} onReady={() => { setSceneReady(true); if (passengerAnchor) sceneHandle.current?.lookAt(passengerAnchor.id); }} paused={busy || dialogueBusy || remaining === 0 || dialoguePending || panelOpen || !entered} onMove={onMove} onTravelChange={setWalkingTo} onInteract={interact} handle={sceneHandle} /> :
          <div className="immersive-stage-placeholder"><Headphones size={34} /><h2>{complete ? 'Тренировка завершена' : 'Разверните телефон горизонтально'}</h2>{!complete && <p>Так будет удобнее управлять и видеть вагон.</p>}</div>}
        {!complete && !compact && !entered && <div className="immersive-intro"><small>{view.course && view.course.completed > 0 ? `Ситуация ${view.course.completed} завершена · ${outcomeLabel(view.course.outcomes.at(-1)?.outcome ?? '')}` : 'ПАССАЖИРУ НУЖНА ПОМОЩЬ'}</small><h2>{view.currentScenarioTitle}</h2>{view.course && <p>Ситуация {view.course.current} из {view.course.total}</p>}{view.course && view.course.completed > 0 && <div className="intro-result"><strong>{view.course.outcomes.at(-1)?.title}</strong><p>{view.history.at(-1)?.explanation}</p></div>}<p>{world?.scene.brief}</p><blockquote>{world?.scene.passenger.initialLine}</blockquote><p className="intro-instruction">Первый шаг: <strong>{selected?.text ?? 'Поговорить с пассажиром'}</strong>. Кнопка «Идти к цели» проведёт по вагону. У цели нажмите «Выполнить» или назовите действие голосом.</p><button className="button primary" disabled={!sceneReady} onClick={enterScene}>{sceneReady ? `Начать${view.course ? ` ситуацию ${view.course.current}` : ' тренировку'}` : 'Загружаем вагон…'} <ArrowRight size={17}/></button></div>}
        {!complete && !compact && entered && !panelOpen && <div className="immersive-interaction">
          {nearPassenger && <div className="immersive-subtitle"><div><small>{message.label}</small></div><p>{voiceState.recording ? `Запись · ${voiceState.seconds} с. Нажмите пробел ещё раз, чтобы отправить.` : voiceState.busy || dialoguePending ? 'Обрабатываем реплику…' : message.text}</p></div>}
          <div className="context-actions">
            {modules.voice && <button type="button" className={`button primary voice-trigger${voiceState.recording ? ' is-recording' : ''}`} disabled={voiceState.busy} onClick={() => dialogueHandle.current?.toggleMic()}>{voiceState.recording ? `Отправить · ${voiceState.seconds} с` : voiceState.busy ? 'Подключаем…' : 'Голосовая команда'} <kbd>Пробел</kbd></button>}
            <button type="button" className="button context-secondary" onClick={openConversation}>Диалог с пассажиром</button>
          </div>
        </div>}
        {!complete && !compact && entered && !panelOpen && <TaskGuide view={view} selected={selected} walkingTo={walkingTo} busy={busy || dialogueBusy || !!dialoguePending || remaining === 0 || !!pending.current || !sceneReady} nearPassenger={nearPassenger} onSelect={id => {sceneHandle.current?.stop(); setSelectedId(id);}} onApproach={approach} onStop={() => sceneHandle.current?.stop()} onAction={(kind,id) => void act(kind,id)}/>}
        {!complete && !compact && entered && !panelOpen && <p className="game-control-hint">WASD — идти · перетаскивайте обзор мышью · E — действие · Esc — остановиться</p>}
        {!compact && !panelOpen && (error || resource.error) && <div className="immersive-operation-error" role="alert"><strong>Действие не подтверждено</strong><p>{error || resource.error}</p><button onClick={() => void refreshStep()} disabled={busy}>Обновить состояние</button>{pending.current && <button onClick={() => void retry()} disabled={busy}>Повторить действие</button>}</div>}
        {voiceState.error && !panelOpen && <div className="immersive-voice-error" role="alert">{voiceState.error}{nearPassenger && <button onClick={() => dialogueHandle.current?.replay()}><Volume2 size={16}/> Включить звук</button>}</div>}
        {world && !compact && !complete && <div className="immersive-touch-controls" aria-label="Экранное управление">
          {(['forward','left','back','right'] as const).map((direction) => <button key={direction} type="button" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); sceneHandle.current?.move(direction, true); }} onPointerUp={() => sceneHandle.current?.move(direction, false)} onPointerCancel={() => sceneHandle.current?.move(direction, false)}>{({ forward:'↑',left:'←',back:'↓',right:'→' })[direction]}</button>)}
        </div>}
      </section>
      <aside data-panel={complete ? 'menu' : panelKind} className={'immersive-hud' + (!panelOpen && !complete ? ' collapsed' : '')} aria-hidden={!panelOpen && !complete}><h2 className="game-panel-title">{complete ? 'Итог тренировки' : panelKind === 'conversation' ? world?.scene.passenger.name : 'Меню уровня'}</h2>
        <div className="immersive-heading"><span>Сценарий · {view.currentScenarioTitle}</span><h1>{view.title}</h1>{world && <p>{world.scene.passenger.name} · {world.scene.passenger.description}</p>}</div>
        <div className="immersive-score"><div><span>Лояльность</span><strong>{view.score.loyalty}/100</strong><i style={{ width: `${view.score.loyalty}%` }} /></div><div><span>Безопасность</span><strong>{view.score.safety}/100</strong><i style={{ width: `${view.score.safety}%` }} /></div></div>
        {world && world.service !== 'none' && <p className={'immersive-service ' + world.service}>{world.service === 'requested' ? 'Услуга запрошена. Выполнение ещё не подтверждено.' : 'Выполнение услуги подтверждено.'}</p>}
        {resource.error && <div className="immersive-alert" role="alert">Не удалось обновить состояние: {resource.error}<div><button onClick={() => void reload()}>Повторить</button></div></div>}
        {error && <div className="immersive-alert" role="alert">{error}<div><button onClick={() => void retry()} disabled={busy || !pending.current}>Повторить запрос</button><button onClick={() => void refreshStep()} disabled={busy}>Обновить</button></div></div>}
        {complete ? <div className="immersive-end"><h2>{outcomeLabel(view.outcome, view.outcomeTitle)}</h2><p>{view.outcomeText || 'Результат сохранён.'}</p>
          {view.course && <><h3>Завершено {view.course.completed} из {view.course.total}</h3><p>Решено: {view.course.outcomes.filter(item => item.outcome === 'resolved').length}. Остальные ситуации доступны для повторной тренировки.</p><ol>{view.course.outcomes.map(item => <li key={item.scenarioId}>{item.title} — {outcomeLabel(item.outcome)}</li>)}</ol></>}
          {continuation.error && <p role="alert">Не удалось найти следующий сценарий. <button onClick={() => void continuation.reload()}>Повторить</button></p>}
          {continuation.value?.next && <button className="button primary" disabled={busy} onClick={() => void startNext(continuation.value!.next!.id)}>Следующий сценарий: {continuation.value.next.title} <ArrowRight size={16}/></button>}
          {continuation.value && !continuation.value.next && <p>Это последняя ситуация маршрута. Можно начать полный курс или вернуться к обучению.</p>}
          <div className="immersive-end-links">{modules.progress && view.resultId && <Link className="button primary" to={`/results/${encodeURIComponent(view.resultId)}`}>Полный разбор <ArrowRight size={16} /></Link>}{modules.progress && <Link className="button" to="/progress?recent=1">К истории</Link>}{modules.account && <Link className="button" to="/account">К кабинету</Link>}<Link className="button" to="/scenarios">К сценариям</Link></div></div> : <>
          <div className="immersive-situation"><span>Текущая задача</span><h2>{view.currentSituation?.title || 'Следующий шаг'}</h2><p>{view.currentSituation?.text}</p></div>
          {world && <Dialogue key={`${view.id}:${view.currentScenarioId}`} handle={dialogueHandle} onState={setVoiceState} entered={entered && sceneReady} nearPassenger={nearPassenger} onBusy={onDialogueBusy} onPrepare={prepareDialogue} view={view} voiceEnabled={modules.voice} onUpdate={apply} onRefresh={reload} />}
          {view.commandFeedback && <p className="immersive-command-feedback" role="status">{view.commandFeedback.text}</p>}
          {panelKind === 'menu' && <div className="original-menu-actions"><button className="button primary" onClick={() => setPanelOpen(false)}>Вернуться в вагон <ArrowRight size={16}/></button><button className="button" onClick={() => { setPanelOpen(false); dialogueHandle.current?.toggleMic(); }} disabled={!nearPassenger || !entered}>Говорить с пассажиром</button><button className="button" onClick={() => dialogueHandle.current?.toggleSound()}>Голос пассажира · {voiceState.sound ? 'Включён' : 'Выключен'}</button></div>}
          {view.answers.length > 0 && <div className="immersive-choices"><h3>Решение</h3>{view.answers.map((answer) => <button key={answer.id} disabled={busy || dialogueBusy || dialoguePending || !entered || !nearPassenger || remaining === 0 || !!pending.current} onClick={() => void act('answer', answer.id)}>{answer.text}<ArrowRight size={17} /></button>)}</div>}
          {world && actions.length > 0 && <div className="immersive-actions"><h3>Действия в вагоне</h3>{actions.map((action: AvailableWorldAction) => {
            const stationId = action.command === 'move_actor' ? world.actorAnchorId : action.targetId;
            const anchor = world.scene.anchors.find((a) => a.id === stationId);
            return <div className={'immersive-action' + (selected?.id === action.id ? ' selected' : '')} key={action.id}>
              <button className="immersive-action-select" onClick={() => setSelectedId(action.id)}><span>{action.text}</span><small>{anchor?.label || action.targetId}</small></button>
              {action.description && <p className="immersive-action-description">{action.description}</p>}
              {!action.available && <p className="immersive-action-reason">{action.reason || 'Действие пока недоступно.'}</p>}
              <div className="immersive-action-buttons"><button onClick={() => { setSelectedId(action.id); approach(stationId); }} disabled={busy || dialoguePending || remaining === 0}><MapPin size={15} /> Идти к точке</button><button onClick={() => void act('world-action', action.id)} disabled={!action.available || busy || dialoguePending || remaining === 0 || !!pending.current}>Выполнить</button></div>
            </div>;
          })}</div>}
          {selected && target && <div className="immersive-target"><MapPin size={18} /><span>Цель: <strong>{target.label}</strong>{metres !== null && ` · ${metres} м`}</span></div>}

        </>}
        <div className="immersive-history"><h3>История решений</h3>{view.history.length ? <ol>{view.history.map((item) => <li key={item.id}><strong>{item.kind === 'timeout' ? 'Время истекло' : item.answerText}</strong><span>{item.explanation}</span><small>Лояльность {item.before.loyalty} → {item.after.loyalty} · Безопасность {item.before.safety} → {item.after.safety}</small></li>)}</ol> : <p>Решения появятся здесь после подтверждения сервером.</p>}</div>
        <Link className="immersive-exit" to="/scenarios"><ArrowLeft size={16} /> Сохранить и выйти к практике</Link>
      </aside>
    </div>
  </div>;
}

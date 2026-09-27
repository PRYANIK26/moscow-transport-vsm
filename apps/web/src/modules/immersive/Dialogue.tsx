import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Send, Square, Volume2 } from 'lucide-react';
import type { SessionView, TurnAccepted, TurnRequest, VoiceRequest } from '@vsm/shared';
import { api, ApiError } from '../../lib/api';
import { errorText } from '../../lib/ui';
import { PcmRecorder } from './audio';

export type VoiceState = { recording: boolean; busy: boolean; seconds: number; error: string; sound: boolean; speaking: boolean; loading: boolean };
export type DialogueHandle = { toggleMic: () => void; replay: () => void; toggleSound: () => void };
type Props = {
  view: SessionView; voiceEnabled: boolean; nearPassenger: boolean; entered: boolean;
  handle: React.RefObject<DialogueHandle | null>;
  onState: (state: VoiceState) => void;
  onBusy: (busy: boolean) => void;
  onPrepare: () => Promise<SessionView | null>;
  onUpdate: (view: SessionView) => void;
  onRefresh: () => Promise<SessionView | null | undefined>;
};
function base64(audio: ArrayBuffer) {
  const bytes = new Uint8Array(audio); let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function Dialogue(props: Props) {
  const { view, voiceEnabled, nearPassenger, entered, handle } = props;
  const dialogue = view.world?.dialogue;
  const pending = dialogue?.status === 'pending';
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [sound, setSound] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);
  const recorder = useRef<PcmRecorder | null>(null);
  const playback = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const cache = useRef(new Map<string, Promise<Blob>>());
  const generation = useRef(0);
  const mounted = useRef(true);
  const operation = useRef(false);
  const pendingTurn = useRef<TurnRequest | null>(null);
  const current = useRef(props); current.current = props;
  const seen = useRef(new Set(dialogue?.messages.map(message => message.id)));
  const greeted = useRef(new Set<string>());
  const end = useRef<HTMLDivElement>(null);
  const initialKey = `initial:${view.currentScenarioId}`;
  const lastReply = dialogue?.messages.filter(message => message.role === 'passenger').at(-1);
  function lock(value: boolean) { operation.current = value; current.current.onBusy(value); }
  function stopAudio() {
    generation.current++;
    playback.current?.pause();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    if (mounted.current) { setSpeaking(false); setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; recorder.current?.cancel(); stopAudio(); current.current.onBusy(false); };
  }, []);
  useEffect(() => {
    current.current.onState({ recording, busy: busy || pending, seconds, error, sound, speaking, loading });
  }, [recording, busy, pending, seconds, error, sound, speaking, loading]);
  useEffect(() => {
    if (!recording) return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [recording]);
  useEffect(() => { const box = end.current?.parentElement; if (box) box.scrollTop = box.scrollHeight; }, [dialogue?.messages.length]);

  async function sendText(value: string, alreadyLocked = false) {
    const p = current.current;
    if (!value.trim() || (!alreadyLocked && operation.current) || p.view.status !== 'active') return;
    if (!p.entered) { setError('Начните сценарий, чтобы говорить и выполнять команды.'); return; }
    lock(true); setBusy(true); setError(''); stopAudio();
    try {
      const latest = await p.onPrepare() ?? current.current.view;
      const payload = pendingTurn.current?.text === value.trim() && pendingTurn.current.expectedVersion === latest.version
        ? pendingTurn.current : { text: value.trim(), expectedVersion: latest.version, requestId: crypto.randomUUID() };
      pendingTurn.current = payload;
      const accepted = await api.post<TurnAccepted>(`/sessions/${encodeURIComponent(latest.id)}/turn`, payload);
      pendingTurn.current = null; setText(''); p.onUpdate(accepted.session);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) await p.onRefresh();
      setText(value); setError(`Не удалось отправить реплику: ${errorText(failure)}. Текст сохранён в диалоге.`);
    } finally { setBusy(false); lock(false); }
  }
  async function startRecording() {
    const p = current.current;
    if (!p.voiceEnabled || operation.current || p.view.world?.dialogue?.status === 'pending' || p.view.status !== 'active') return;
    if (!p.entered) { setError('Начните сценарий, чтобы говорить и выполнять команды.'); return; }
    lock(true); setBusy(true); setError(''); stopAudio();
    try {
      await p.onPrepare();
      const item = await PcmRecorder.start(() => void actions.current.stopRecording());
      if (!mounted.current) { item.cancel(); return; }
      recorder.current = item; setSeconds(0); setRecording(true);
    } catch (failure) { setError(errorText(failure)); lock(false); }
    finally { setBusy(false); }
  }
  async function stopRecording() {
    const item = recorder.current; if (!item) return;
    recorder.current = null; setRecording(false); setBusy(true); setError('');
    try {
      const audio = await item.stop();
      if (audio.byteLength < 3200) throw new Error('Запись слишком короткая. Говорите не менее секунды.');
      const p = current.current;
      const latest = await p.onPrepare() ?? p.view;
      const result = await api.post<{text: string}>(`/sessions/${encodeURIComponent(latest.id)}/voice`, {
        audioBase64: base64(audio), expectedVersion: latest.version, requestId: crypto.randomUUID(),
      } satisfies VoiceRequest);
      if (!mounted.current) return;
      setText(result.text);
      // Same interaction as the original game: second Space sends the voice turn.
      await sendText(result.text, true);
    } catch (failure) { setError(`Не удалось распознать речь: ${errorText(failure)}`); }
    finally { setBusy(false); lock(false); }
  }
  async function speak(key: string) {
    if (!current.current.voiceEnabled || recorder.current) return;
    stopAudio(); const ticket = generation.current; setLoading(true); setError('');
    try {
      let promise = cache.current.get(key);
      if (!promise) {
        promise = api.audio(`/sessions/${encodeURIComponent(current.current.view.id)}/speech`,
          key.startsWith('initial:') ? { initialScenarioId: key.slice(8) } : { messageId: key });
        cache.current.set(key, promise); void promise.catch(() => cache.current.delete(key));
      }
      const blob = await promise;
      if (!mounted.current || ticket !== generation.current) return;
      const url = URL.createObjectURL(blob); objectUrl.current = url;
      const audio = playback.current ?? new Audio(); playback.current = audio; audio.src = url;
      audio.onplaying = () => { if (ticket === generation.current) setSpeaking(true); };
      audio.onended = () => { if (ticket === generation.current) stopAudio(); };
      await audio.play();
    } catch (failure) {
      if (mounted.current && ticket === generation.current) setError(
        failure instanceof DOMException && failure.name === 'NotAllowedError'
          ? 'Нажмите значок звука у реплики, чтобы включить озвучку.' : `Звук недоступен: ${errorText(failure)}`);
    } finally { if (mounted.current && ticket === generation.current) setLoading(false); }
  }
  const actions = useRef({ startRecording, stopRecording, speak }); actions.current = { startRecording, stopRecording, speak };
  handle.current = {
    toggleMic: () => { void (recorder.current ? actions.current.stopRecording() : actions.current.startRecording()); },
    replay: () => { void speak(lastReply?.id ?? initialKey); },
    toggleSound: () => { setSound(value => !value); if (sound) stopAudio(); },
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if ((event.target as HTMLElement)?.closest('input,textarea,select,button,a,summary,[contenteditable="true"]')) return;
      if (!current.current.voiceEnabled) return;
      event.preventDefault(); handle.current?.toggleMic();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [handle]);
  useEffect(() => {
    if (!entered || !nearPassenger || !voiceEnabled || !sound || operation.current) return;
    const key = `${view.id}:${initialKey}`;
    if (greeted.current.has(key)) return;
    greeted.current.add(key);
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'heard');
    } catch { /* Session storage is optional. */ }
    void actions.current.speak(initialKey);
  }, [entered, nearPassenger, voiceEnabled, sound, view.id, initialKey]);
  useEffect(() => {
    const fresh = dialogue?.messages.filter(message => !seen.current.has(message.id)) ?? [];
    for (const message of dialogue?.messages ?? []) seen.current.add(message.id);
    const passenger = fresh.filter(message => message.role === 'passenger').at(-1);
    if (passenger && sound && voiceEnabled && !operation.current) void actions.current.speak(passenger.id);
  }, [dialogue?.messages, sound, voiceEnabled]);

  return <section className="original-dialogue" aria-label="Диалог с пассажиром">
    <div className="game-conversation">
      <div className="game-message passenger"><small>{view.world?.scene.passenger.name}</small><p>{view.world?.scene.passenger.initialLine}</p></div>
      {dialogue?.messages.slice(-6).map(message => <div className={`game-message ${message.role}`} key={message.id}>
        <small>{message.role === 'conductor' ? 'Вы' : view.world?.scene.passenger.name}</small><p>{message.text}</p>
      </div>)}<div ref={end}/>
    </div>
    <form className="game-chat" onSubmit={event => { event.preventDefault(); void sendText(text); }}>
      <input aria-label="Реплика проводника" placeholder="Реплика или название действия…" value={text} maxLength={600}
        disabled={busy || pending || recording || !entered} onChange={event => { setText(event.target.value); pendingTurn.current = null; }}/>
      <button aria-label="Отправить реплику" disabled={busy || pending || recording || !text.trim() || !entered}>
        {busy || pending ? <LoaderCircle size={19} className="spin"/> : <Send size={19}/>}
      </button>
      {voiceEnabled && <button type="button" aria-label={recording ? 'Отправить голосовую реплику' : 'Говорить с пассажиром'} disabled={busy || pending || !entered} onClick={() => handle.current?.toggleMic()}>
        {recording ? <Square size={18}/> : <Mic size={18}/>}
      </button>}
    </form>
    {recording && <p className="field-hint">Запись · {seconds} с. Нажмите пробел или квадрат для отправки.</p>}
    {error && <p className="field-hint" role="alert">{error} <button type="button" aria-label="Повторить озвучку" onClick={() => handle.current?.replay()}><Volume2 size={16}/></button></p>}
    {dialogue?.warning && dialogue.status === 'failed' && <p role="alert">{dialogue.warning}</p>}
  </section>;
}

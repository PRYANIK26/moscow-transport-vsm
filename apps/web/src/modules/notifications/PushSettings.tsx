import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import type { PushStatus } from '@vsm/shared';
import { api } from '../../lib/api';
import {
  applicationServerKey,
  iosNeedsInstall,
  pushSupported,
  sameApplicationServerKey,
  subscriptionInput,
} from '../../lib/push';
import { errorText, useResource } from '../../lib/ui';

export function PushSettings({ prompt = false, userId }: { prompt?: boolean; userId?: string } = {}) {
  const status = useResource(() => api.get<PushStatus>('/notifications/push'));
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [linked, setLinked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [checkRevision, setCheckRevision] = useState(0);
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    'Notification' in window ? Notification.permission : 'default',
  );
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() =>
    prompt && userId ? window.localStorage.getItem(`vsm:push-dismissed:${userId}`) === '1' : false,
  );
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!pushSupported()) return;
    let active = true;
    setSubscription(null);
    setLinked(false);
    setChecking(true);
    setCheckError('');
    const registration =
      status.value?.configured && !iosNeedsInstall()
        ? navigator.serviceWorker.register('/sw.js', { scope: '/' })
        : navigator.serviceWorker.getRegistration('/');
    void registration
      .then((registration) => registration?.pushManager.getSubscription())
      .then(async (current) => {
        if (!active) return;
        setSubscription(current ?? null);
        if (current && status.value?.configured) {
          const result = await api.post<{ subscribed: boolean }>(
            '/notifications/push/subscriptions/status',
            { endpoint: current.endpoint },
          );
          if (active && result.subscribed) setLinked(true);
          if (
            active &&
            !result.subscribed &&
            Notification.permission === 'granted' &&
            sameApplicationServerKey(current, status.value.publicKey!)
          ) {
            await api.post('/notifications/push/subscriptions', subscriptionInput(current));
            if (active) setLinked(true);
          }
        }
      })
      .catch((e) => {
        if (active) setCheckError(errorText(e));
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    const onFocus = () => setPermission(Notification.permission);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [status.value?.configured, checkRevision]);

  async function enable() {
    if (busy || !status.value?.configured || !status.value.publicKey || !pushSupported()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      // Permission is requested only by this button's direct user gesture.
      const answer =
        Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
      setPermission(answer);
      if (answer !== 'granted') {
        if (prompt && answer === 'default') dismissPrompt();
        setError(
          answer === 'denied'
            ? 'Браузер запретил уведомления. Разрешите их в настройках сайта.'
            : 'Разрешение не предоставлено. Вы можете попробовать позже.',
        );
        return;
      }
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      const active = await navigator.serviceWorker.ready;
      let current = await active.pushManager.getSubscription();
      if (current && !sameApplicationServerKey(current, status.value.publicKey)) {
        if (!(await current.unsubscribe()))
          throw new Error('Не удалось обновить подписку браузера. Повторите попытку.');
        current = null;
        setSubscription(null);
        setLinked(false);
      }
      const created = !current;
      if (!current)
        current = await active.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(status.value.publicKey),
        });
      try {
        await api.post('/notifications/push/subscriptions', subscriptionInput(current));
      } catch (e) {
        if (created) await current.unsubscribe().catch(() => {});
        if (created) setSubscription(null);
        setLinked(false);
        throw e;
      }
      setSubscription(current);
      setLinked(true);
      setMessage('Уведомления включены для этого устройства.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (busy || !subscription) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api.delete('/notifications/push/subscriptions', { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
      setSubscription(null);
      setLinked(false);
      setMessage('Уведомления отключены на этом устройстве.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function dismissPrompt() {
    setDismissed(true);
    if (userId) window.localStorage.setItem(`vsm:push-dismissed:${userId}`, '1');
  }

  if (prompt && (
    dismissed || !status.value?.configured || !pushSupported() || iosNeedsInstall() ||
    permission === 'denied' || checking || linked
  )) return null;

  if (dismissed)
    return (
      <button className="text-button push-reopen" onClick={() => setDismissed(false)}>
        Настроить уведомления
      </button>
    );
  return (
    <section className="push-settings" aria-labelledby={prompt ? 'push-prompt-title' : 'push-title'}>
      <div className="section-heading">
        <BellRing size={20} /> <h2 id={prompt ? 'push-prompt-title' : 'push-title'}>{prompt ? 'Получать новые сценарии' : 'Уведомления устройства'}</h2>
      </div>
      {prompt && <p>Включите уведомления, чтобы узнавать о новых сценариях.</p>}
      {status.loading && !status.value ? (
        <p className="muted">Проверяем возможность подключения…</p>
      ) : status.error ? (
        <p role="alert">
          {status.error}{' '}
          <button className="text-button" onClick={() => void status.reload()}>
            Повторить
          </button>
        </p>
      ) : !status.value?.configured ? (
        <p className="muted">
          Отправка на устройство пока не настроена. Сообщения остаются в этой ленте.
        </p>
      ) : iosNeedsInstall() ? (
        <p className="muted">
          На iPhone и iPad добавьте сайт на экран «Домой», откройте его с иконки и включите
          уведомления здесь.
        </p>
      ) : !pushSupported() ? (
        <p className="muted">
          Этот браузер или соединение не поддерживает push-уведомления. Сообщения доступны в ленте.
        </p>
      ) : checking ? (
        <p className="muted">Проверяем уведомления…</p>
      ) : permission === 'denied' ? (
        <>
          <p className="muted">
            Уведомления запрещены в настройках браузера для этого сайта. Разрешите их там, затем
            вернитесь сюда.
          </p>
          {subscription && (
            <button className="button" disabled={busy} onClick={() => void disable()}>
              Отключить подписку
            </button>
          )}
        </>
      ) : linked && subscription ? (
        <>
          <p>Уведомления включены на этом устройстве.</p>
          <button className="button" disabled={busy} onClick={() => void disable()}>
            {busy ? 'Отключаем…' : 'Отключить уведомления'}
          </button>
        </>
      ) : (
        <div>
          {subscription && (
            <p className="muted">Уведомления на этом устройстве пока не включены.</p>
          )}
          <div className="button-row">
            <button className="button primary" disabled={busy} onClick={() => void enable()}>
              {busy ? 'Подключаем…' : 'Включить уведомления'}
            </button>
            <button className="text-button" disabled={busy} onClick={dismissPrompt}>
              Не сейчас
            </button>
          </div>
        </div>
      )}
      {checkError && (
        <p className="form-error" role="alert">
          Не удалось проверить уведомления: {checkError}{' '}
          <button className="text-button" onClick={() => setCheckRevision((value) => value + 1)}>
            Повторить
          </button>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="form-success" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

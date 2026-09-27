import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { NotificationsStatus } from '@vsm/shared';
import { api } from './api';

const NotificationContext = createContext<{ count: number | null; refresh: () => void }>({
  count: null,
  refresh: () => {},
});

export function notificationChanged() {
  window.dispatchEvent(new Event('vsm:notification-changed'));
}

export function NotificationStatusProvider({
  enabled,
  userId,
  children,
}: {
  enabled: boolean;
  userId: string;
  children: ReactNode;
}) {
  const [count, setCount] = useState<number | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(() => {
    if (!enabled || document.visibilityState === 'hidden') return;
    const current = ++generation.current;
    void api
      .get<NotificationsStatus>('/notifications/status')
      .then((status) => {
        if (current === generation.current) setCount(status.unreadCount);
      })
      .catch(() => {
        if (current === generation.current) setCount(null);
      });
  }, [enabled, userId]);
  useEffect(() => {
    generation.current++;
    setCount(null);
    if (!enabled) return;
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'vsm:push') refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('vsm:notification-changed', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      generation.current++;
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('vsm:notification-changed', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [enabled, refresh]);
  return (
    <NotificationContext.Provider value={{ count: enabled ? count : null, refresh }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationStatus() {
  return useContext(NotificationContext);
}

import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { ApiError } from './api';

export function notifyApiError(error: unknown) {
  if (error instanceof ApiError && error.code === 'MODULE_DISABLED')
    window.dispatchEvent(new Event('vsm:module-disabled'));
  if (error instanceof ApiError && error.status === 401)
    window.dispatchEvent(new Event('vsm:unauthenticated'));
}
export function errorText(error: unknown): string {
  notifyApiError(error);
  if (error instanceof Error) return error.message;
  return 'Не удалось загрузить данные. Проверьте соединение и повторите попытку.';
}
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const key = JSON.stringify(deps);
  const generation = useRef(0);
  const [state, setState] = useState<{
    key: string;
    value: T | null;
    loading: boolean;
    error: string;
  }>({
    key,
    value: null,
    loading: true,
    error: '',
  });
  const reload = useCallback(async () => {
    const request = ++generation.current;
    setState((previous) => ({
      key,
      value: previous.key === key ? previous.value : null,
      loading: true,
      error: '',
    }));
    try {
      const data = await load();
      if (request === generation.current) setState({ key, value: data, loading: false, error: '' });
      return data;
    } catch (e) {
      if (request === generation.current)
        setState((previous) => ({
          key,
          value: previous.key === key ? previous.value : null,
          loading: false,
          error: errorText(e),
        }));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const setValue = useCallback(
    (next: SetStateAction<T | null>) => {
      setState((previous) => {
        if (previous.key !== key) return previous;
        const value =
          typeof next === 'function'
            ? (next as (before: T | null) => T | null)(previous.value)
            : next;
        return { ...previous, value };
      });
    },
    [key],
  );
  return {
    value: state.key === key ? state.value : null,
    loading: state.key === key ? state.loading : true,
    error: state.key === key ? state.error : '',
    reload,
    setValue,
  };
}
export function Status({
  loading,
  error,
  retry,
  empty,
  children,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
  empty?: boolean;
  children: React.ReactNode;
}) {
  if (loading && !children)
    return (
      <div className="status" role="status">
        Загружаем данные…
      </div>
    );
  if (error && !children)
    return (
      <div className="status status-error" role="alert">
        <p>{error}</p>
        <button type="button" onClick={retry}>
          Повторить
        </button>
      </div>
    );
  if (empty) return <div className="status">Пока нет данных.</div>;
  return <>{children}</>;
}
export function dateTime(date: string | null | undefined) {
  return date
    ? new Intl.DateTimeFormat('ru-RU', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Europe/Moscow',
      }).format(new Date(date))
    : '—';
}
export function outcomeLabel(outcome: string | null | undefined, title?: string | null) {
  if (title?.trim()) return title;
  return (
    (
      {
        resolved: 'Решение найдено',
        partial: 'Частичное решение',
        timeout: 'Время вышло',
      } as Record<string, string>
    )[outcome ?? ''] ?? 'Тренировка завершена'
  );
}
export function number(value: number) {
  return new Intl.NumberFormat('ru-RU').format(value);
}
export function roleName(role: string) {
  return (
    (
      { student: 'Проводник', author: 'Автор сценариев', admin: 'Администратор' } as Record<
        string,
        string
      >
    )[role] ?? role
  );
}
export function className(value: string) {
  return (
    (
      {
        standard: 'Стандарт',
        comfort: 'Комфорт',
        business: 'Бизнес',
        first: 'Первый класс',
        any: 'Любой класс',
      } as Record<string, string>
    )[value] ?? value
  );
}
export function difficultyName(value: string) {
  return (
    (
      { beginner: 'Начальный', intermediate: 'Средний', advanced: 'Сложный' } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}

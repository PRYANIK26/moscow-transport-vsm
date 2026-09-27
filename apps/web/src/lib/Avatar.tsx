import { useEffect, useState } from 'react';
import type { User } from '@vsm/shared';

export function Avatar({ user, className = '' }: { user: User; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [user.avatarUrl]);
  const initials =
    [user.firstName, user.lastName]
      .filter(Boolean)
      .map((part) => part![0])
      .join('') ||
    user.name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('');
  const src =
    user.avatarUrl?.startsWith('/api/users/') && !user.avatarUrl.includes('\\')
      ? user.avatarUrl
      : null;
  return (
    <span className={`avatar ${className}`} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" onError={() => setFailed(true)} />
      ) : (
        <span>{initials.toLocaleUpperCase('ru-RU') || 'ВС'}</span>
      )}
    </span>
  );
}

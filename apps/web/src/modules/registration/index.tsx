import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TrainFront } from 'lucide-react';
import type { Bootstrap } from '@vsm/shared';
import { api } from '../../lib/api';
import { errorText } from '../../lib/ui';

export default function Registration({ onLogin }: { onLogin: (value: Bootstrap) => void }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.post<Bootstrap>('/auth/register', {
        firstName,
        lastName,
        email,
        password,
      });
      onLogin(data);
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <div className="login-intro">
        <div className="login-brand"><TrainFront size={26} /><span>на борту<small>ТРЕНАЖЁР ПРОВОДНИКА</small></span></div>
        <h1>Ваш первый шаг к уверенной работе</h1>
        <p>
          Создайте личный профиль проводника. Проходите ситуации, сохраняйте прогресс и соревнуйтесь
          в мастерстве.
        </p>
      </div>
      <section className="login-panel">
        <h2>Регистрация проводника</h2>
        <p className="muted">Имя и фамилия будут видны в рейтинге. Почта используется для входа.</p>
        <form onSubmit={submit}>
          <div className="registration-names">
            <div>
              <label htmlFor="first-name">Имя</label>
              <input
                id="first-name"
                autoComplete="given-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                maxLength={50}
                required
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor="last-name">Фамилия</label>
              <input
                id="last-name"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                maxLength={50}
                required
                disabled={busy}
              />
            </div>
          </div>
          <label htmlFor="register-email">Электронная почта</label>
          <input
            id="register-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
            required
            disabled={busy}
          />
          <label htmlFor="register-password">Пароль</label>
          <input
            id="register-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={10}
            maxLength={128}
            aria-describedby="password-hint"
            required
            disabled={busy}
          />
          <p id="password-hint" className="muted">
            Не менее 10 символов.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? 'Создаём профиль…' : 'Зарегистрироваться'}
          </button>
        </form>
        <p className="auth-alternative">
          Уже есть аккаунт? <Link to="/login">Войти</Link>
        </p>
      </section>
    </main>
  );
}

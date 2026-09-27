import {
  Component,
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Menu,
  TrainFront,
  X,
} from 'lucide-react';
import {
  DEMO_ACCOUNTS,
  type Bootstrap,
  type ModuleFlags,
  type ModuleId,
  type User,
} from '@vsm/shared';
import { api, ApiError } from '../lib/api';
import { Avatar } from '../lib/Avatar';
import { NotificationStatusProvider, useNotificationStatus } from '../lib/notificationStatus';
import { unlinkPushForLogout } from '../lib/push';
import { PushSettings } from '../modules/notifications/PushSettings';
import { errorText, roleName } from '../lib/ui';

const Registration = lazy(() => import('../modules/registration'));
const Leaderboard = lazy(() => import('../modules/leaderboard'));
const Account = lazy(() => import('../modules/account'));
const Learning = lazy(() => import('../modules/play/Learning'));
const Play = lazy(() => import('../modules/play/Play'));
const Immersive = lazy(() => import('../modules/immersive'));
const Progress = lazy(() => import('../modules/progress/Progress'));
const Result = lazy(() => import('../modules/progress/Result'));
const Notifications = lazy(() => import('../modules/notifications'));
const Team = lazy(() => import('../modules/team'));
const Admin = lazy(() => import('../modules/admin'));
const Editor = lazy(() => import('../modules/editor'));

type Auth = {
  user: User;
  modules: ModuleFlags;
  refresh: () => Promise<void>;
  setModules: (flags: ModuleFlags) => void;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
};
const AuthContext = createContext<Auth | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('Не загружен вход');
  return value;
}

class RouteError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="status status-error" role="alert">
        <h2>Раздел не открылся</h2>
        <p>Данные других разделов доступны. Попробуйте открыть этот раздел снова.</p>
        <button onClick={() => this.setState({ failed: false })}>Повторить</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Isolated({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <RouteError key={location.key}>
      <Suspense
        fallback={
          <div className="status" role="status">
            Открываем раздел…
          </div>
        }
      >
        {children}
      </Suspense>
    </RouteError>
  );
}
function firstPath(modules: ModuleFlags) {
  if (modules.play || modules.materials) return '/learning';
  return (
    ['account', 'progress', 'leaderboard', 'team', 'notifications'] as ModuleId[]
  ).find((id) => modules[id])
    ? (
        {
          account: '/account',
          progress: '/progress',
          team: '/team',
          leaderboard: '/leaderboard',
          notifications: '/notifications',
        } as Record<string, string>
      )[
        (
          ['account', 'progress', 'leaderboard', 'team', 'notifications'] as ModuleId[]
        ).find((id) => modules[id])!
      ]
    : '/available';
}
function Protected({
  module,
  roles,
  children,
}: {
  module?: ModuleId;
  roles?: string[];
  children: ReactNode;
}) {
  const { user, modules } = useAuth();
  if (roles && !roles.includes(user.role)) return <Navigate to="/forbidden" replace />;
  if (module && !modules[module]) return <Disabled module={module} />;
  return <Isolated>{children}</Isolated>;
}
const LABELS: Record<ModuleId, string> = {
  account: 'Личный кабинет',
  play: 'Сценарии',
  editor: 'Редактор',
  notifications: 'Уведомления',
  progress: 'Прогресс',
  team: 'Моя бригада',
  leaderboard: 'Лидерборд',
  immersive: '3D-тренировка',
  voice: 'Голос',
  materials: 'Материалы',
};
function Disabled({ module }: { module: ModuleId }) {
  return (
    <div className="status">
      <h1>Раздел «{LABELS[module]}» временно недоступен</h1>
      <p>Данные раздела сохранены. Вы можете открыть другие доступные разделы.</p>
      <Link className="button" to="/">
        К доступным разделам
      </Link>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (value: Bootstrap) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(e: React.FormEvent, demo?: { email: string; password: string }) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const bootstrap = await api.post<Bootstrap>('/auth/login', demo ?? { email, password });
      onLogin(bootstrap);
      navigate(firstPath(bootstrap.modules), { replace: true });
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
        <h1>Спокойствие на борту.</h1>
        <p>Тренируйтесь на рабочих ситуациях, разбирайте последствия и отслеживайте свой прогресс.</p>
      </div>
      <section className="login-panel">
        <h2>Войти в систему</h2>
        <form onSubmit={submit}>
          <label htmlFor="email">Электронная почта</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full" disabled={busy} type="submit">
            {busy ? 'Входим…' : 'Войти'}
          </button>
        </form>
        <p className="auth-alternative">
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </p>
        <div className="demo">
          <h3>Демо-доступ</h3>
          <p>Вымышленные учётные записи для знакомства с ролями.</p>
          {DEMO_ACCOUNTS.map((item) => (
            <button
              disabled={busy}
              key={item.email}
              type="button"
              onClick={(e) => void submit(e, { email: item.email, password: item.password })}
            >
              <span>{item.label}</span>
              <span className="muted">{item.email}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
function NotificationBell() {
  const { count } = useNotificationStatus();
  const label =
    count === null
      ? 'Уведомления'
      : count === 0
        ? 'Уведомления, непрочитанных нет'
        : `Уведомления, непрочитанных: ${count}`;
  return (
    <Link className="header-bell" to="/notifications" aria-label={label} title={label}>
      <Bell size={21} />
      {count !== null && count > 0 && <span className="unread-dot" />}
    </Link>
  );
}
function ProfileControl({
  user,
  enabled,
  compact = false,
}: {
  user: User;
  enabled: boolean;
  compact?: boolean;
}) {
  const content = (
    <>
      <Avatar user={user} className="avatar-header" />
      {!compact && (
        <span className="profile-control-text">
          <strong>{user.name}</strong>
          <small>{user.brigade}</small>
        </span>
      )}
    </>
  );
  const className = `profile-control ${compact ? 'compact' : ''}`;
  return enabled ? (
    <Link to="/account" className={className} aria-label={`Открыть кабинет: ${user.name}`}>
      {content}
    </Link>
  ) : (
    <div className={className} aria-label={`Профиль: ${user.name}. Кабинет недоступен`}>
      {content}
    </div>
  );
}
function Shell({ children }: { children: ReactNode }) {
  const { user, modules, logout } = useAuth();
  const location = useLocation();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);
  const nav = [
    { id: 'learning', to: '/learning', label: 'Обучение' },
    { id: 'progress', to: '/progress', label: 'Результаты' },
    { id: 'account', to: '/account', label: 'Кабинет' },
    { id: 'leaderboard', to: '/leaderboard', label: 'Рейтинг' },
    { id: 'team', to: '/team', label: 'Бригада' },
    { id: 'notifications', to: '/notifications', label: 'Уведомления' },
    { id: 'editor', to: '/editor', label: 'Редактор' },
  ].filter((item) => (item.id === 'learning' ? modules.play || modules.materials : modules[item.id as ModuleId]) && (item.id !== 'editor' || user.role !== 'student'));
  if (user.role === 'admin') nav.push({ id: 'admin', to: '/admin', label: 'Управление' });
  return <NotificationStatusProvider enabled={modules.notifications} userId={user.id}>
    <div className="app-frame second-shell">
      <a className="skip" href="#main">Перейти к содержимому</a>
      <header className="site-header">
        <Link className="second-brand" to="/"><TrainFront size={25} /><span>на борту<small>ТРЕНАЖЁР ПРОВОДНИКА</small></span></Link>
        <nav className={menu ? 'open' : ''} aria-label="Основная навигация">
          {nav.map((item, index) => <NavLink key={item.to} to={item.to} className={({ isActive }) => `second-nav-item${index > 3 ? ' second-nav-extra' : ''}${isActive ? ' active' : ''}`}>{item.label}</NavLink>)}
          {nav.length > 4 && <details className="second-more" key={location.pathname}><summary>Ещё</summary><div>{nav.slice(4).map((item) => <NavLink key={item.to} to={item.to}>{item.label}</NavLink>)}</div></details>}
        </nav>
        <div className="second-header-actions">
          {modules.notifications && <NotificationBell />}
          <ProfileControl user={user} enabled={modules.account} compact />
          <button type="button" className="second-menu" aria-label={menu ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={menu} onClick={() => setMenu(!menu)}>{menu ? <X size={22}/> : <Menu size={22}/>}</button>
        </div>
      </header>
      {menu && <button className="second-menu-backdrop" aria-label="Закрыть меню" onClick={() => setMenu(false)}/>}
      <div className="second-workspace"><main id="main" className="main-content" tabIndex={-1}>{modules.notifications && location.pathname !== '/notifications' && <PushSettings prompt userId={user.id} />}{children}</main><footer className="second-footer"><span>на борту · ВСМ</span><span>{roleName(user.role)}</span><button onClick={() => void logout()}><LogOut size={16}/> Выйти</button></footer></div>
    </div>
  </NotificationStatusProvider>;
}
function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      const value = await api.get<Bootstrap>('/me');
      setBootstrap(value);
      setError('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setBootstrap(null);
        return;
      }
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!bootstrap) return;
    const update = () => {
      void api
        .get<Bootstrap>('/me')
        .then((value) => setBootstrap(value))
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) setBootstrap(null);
        });
    };
    const interval = window.setInterval(update, 15000);
    const focus = () => update();
    const disabled = () => update();
    const unauth = () => setBootstrap(null);
    window.addEventListener('focus', focus);
    window.addEventListener('vsm:module-disabled', disabled);
    window.addEventListener('vsm:unauthenticated', unauth);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('vsm:module-disabled', disabled);
      window.removeEventListener('vsm:unauthenticated', unauth);
    };
  }, [bootstrap?.user.id]);
  if (loading)
    return (
      <div className="app-loading" role="status">
        Загружаем рабочее пространство…
      </div>
    );
  if (!bootstrap)
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={setBootstrap} />} />
        <Route
          path="/register"
          element={
            <Isolated>
              <Registration onLogin={setBootstrap} />
            </Isolated>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  const auth: Auth = {
    user: bootstrap.user,
    modules: bootstrap.modules,
    refresh,
    setModules: (modules) => setBootstrap((v) => (v ? { ...v, modules } : v)),
    setUser: (user) => setBootstrap((v) => (v ? { ...v, user } : v)),
    logout: async () => {
      try {
        await unlinkPushForLogout(bootstrap.modules.notifications).catch(() => {});
        await api.post('/auth/logout');
        setBootstrap(null);
        navigate('/login', { replace: true });
      } catch (e) {
        setError(`Не удалось выйти: ${errorText(e)}`);
      }
    },
  };
  return (
    <AuthContext.Provider value={auth}>
      <Shell>
        {error && (
          <div className="inline-warning" role="alert">
            Не удалось обновить данные входа: {error}{' '}
            <button onClick={() => void refresh()}>Повторить</button>
          </div>
        )}
        <Routes>
          <Route path="/login" element={<Navigate to={firstPath(bootstrap.modules)} replace />} />
          <Route
            path="/register"
            element={<Navigate to={firstPath(bootstrap.modules)} replace />}
          />
          <Route path="/" element={<Navigate to={firstPath(bootstrap.modules)} replace />} />
          <Route
            path="/available"
            element={
              <div className="status">
                <LayoutDashboard size={28} />
                <h1>Рабочее пространство</h1>
                <p>
                  Сейчас все пользовательские разделы отключены. Вход и управление доступом
                  продолжают работать.
                </p>
                {bootstrap.user.role === 'admin' && (
                  <Link className="button" to="/admin">
                    Управление модулями
                  </Link>
                )}
              </div>
            }
          />
          <Route
            path="/forbidden"
            element={
              <div className="status">
                <h1>Нет доступа</h1>
                <p>Для этого раздела нужны другие права.</p>
                <Link className="button" to="/">
                  На главную
                </Link>
              </div>
            }
          />
          <Route
            path="/account"
            element={
              <Protected module="account">
                <Account />
              </Protected>
            }
          />
          <Route path="/learning" element={<Isolated><Learning /></Isolated>} />
          <Route path="/course" element={<Navigate to="/learning" replace />} />
          <Route path="/scenarios" element={<Navigate to="/learning" replace />} />
          <Route path="/materials" element={<Navigate to="/learning" replace />} />
          <Route
            path="/play/:sessionId"
            element={
              <Protected module="play">
                <Play />
              </Protected>
            }
          />
          <Route
            path="/immersive/:sessionId"
            element={
              <Protected module="play">
                {bootstrap.modules.immersive ? <Immersive /> : <Disabled module="immersive" />}
              </Protected>
            }
          />
          <Route
            path="/progress"
            element={
              <Protected module="progress">
                <Progress />
              </Protected>
            }
          />
          <Route
            path="/results/:resultId"
            element={
              <Protected module="progress">
                <Result />
              </Protected>
            }
          />
          <Route
            path="/notifications"
            element={
              <Protected module="notifications">
                <Notifications />
              </Protected>
            }
          />
          <Route
            path="/leaderboard"
            element={
              <Protected module="leaderboard">
                <Leaderboard />
              </Protected>
            }
          />
          <Route
            path="/team"
            element={
              <Protected module="team">
                <Team />
              </Protected>
            }
          />
          <Route
            path="/admin"
            element={
              <Protected roles={['admin']}>
                <Admin />
              </Protected>
            }
          />
          <Route
            path="/editor"
            element={
              <Protected module="editor" roles={['author', 'admin']}>
                <Editor />
              </Protected>
            }
          />
          <Route
            path="*"
            element={
              <div className="status">
                <h1>Страница не найдена</h1>
                <Link className="button" to="/">
                  На главную
                </Link>
              </div>
            }
          />
        </Routes>
      </Shell>
    </AuthContext.Provider>
  );
}
export default App;

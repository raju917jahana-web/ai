import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import Dashboard from './views/Dashboard.jsx';
import Projects from './views/Projects.jsx';
import ShortsView from './views/ShortsView.jsx';
import Tasks from './views/Tasks.jsx';
import Chat from './views/Chat.jsx';
import Settings from './views/Settings.jsx';

const NAV = [
  { id: 'agent', label: 'AI Agent', icon: '◈' },
  { id: 'dashboard', label: 'Dashboard', icon: '▦' },
  { id: 'projects', label: 'Projects', icon: '▤' },
  { id: 'shorts', label: 'Shorts', icon: '▶' },
  { id: 'approvals', label: 'Approvals', icon: '✓' },
  { id: 'schedule', label: 'Schedule', icon: '◷' },
  { id: 'tasks', label: 'Tasks', icon: '⚙' },
  { id: 'settings', label: 'Settings', icon: '⚒' },
];

export default function App() {
  const [auth, setAuth] = useState({ loading: true, passwordRequired: false, authenticated: false });
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(null);
  const [state, setState] = useState(null);
  const [tab, setTab] = useState('agent');
  const [toasts, setToasts] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const timer = useRef(null);

  const toast = useCallback((message, kind = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { id, message, kind }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.state();
      setState(data);
      setLoadError(null);
      return data;
    } catch (err) {
      if (err.status === 401) setAuth({ loading: false, passwordRequired: true, authenticated: false });
      else setLoadError(err.message);
      return null;
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const status = await api.authStatus();
        setAuth({ loading: false, ...status });
        if (status.authenticated) await refresh();
      } catch (err) {
        setAuth({ loading: false, passwordRequired: false, authenticated: true });
        setLoadError(err.message);
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!auth.authenticated) return undefined;
    const tick = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    timer.current = setInterval(tick, 4500);
    return () => clearInterval(timer.current);
  }, [auth.authenticated, refresh]);

  const login = async (event) => {
    event.preventDefault();
    setLoginError(null);
    try {
      await api.login(password);
      const status = await api.authStatus();
      setAuth({ loading: false, ...status });
      await refresh();
    } catch (err) {
      setLoginError(err.message);
    }
  };

  const counts = useMemo(() => {
    const list = state?.shorts || [];
    return {
      approvals: list.filter((s) => s.status === 'awaiting_approval').length,
      schedule: list.filter((s) => s.status === 'scheduled').length,
      tasks: (state?.jobs || []).filter((j) => ['running', 'queued', 'pause_requested', 'paused'].includes(j.status)).length,
    };
  }, [state]);

  if (auth.loading) return <div className="login"><div className="card">Loading your agent…</div></div>;

  if (!auth.authenticated) {
    return (
      <div className="login">
        <form className="card" onSubmit={login}>
          <div className="brand" style={{ marginBottom: 16 }}>
            <div className="brand-mark">▶</div>
            <div>
              <h1>YouTube Autopilot AI</h1>
              <span>My YouTube AI Agent</span>
            </div>
          </div>
          <label className="field" htmlFor="pw">Access password</label>
          <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="APP_PASSWORD" autoFocus />
          {loginError && <div className="notice err mt">{loginError}</div>}
          <button className="btn primary mt" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Unlock agent</button>
          <p className="small muted mt">This deployment is protected by APP_PASSWORD.</p>
        </form>
      </div>
    );
  }

  const integrations = state?.integrations || {};
  const channel = state?.channel;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">▶</div>
          <div>
            <h1>YouTube Autopilot AI</h1>
            <span>My YouTube AI Agent</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
              <span><span aria-hidden="true" style={{ marginRight: 8, opacity: 0.8 }}>{item.icon}</span>{item.label}</span>
              {item.id === 'approvals' && counts.approvals > 0 && <span className="dot">{counts.approvals}</span>}
              {item.id === 'schedule' && counts.schedule > 0 && <span className="dot">{counts.schedule}</span>}
              {item.id === 'tasks' && counts.tasks > 0 && <span className="dot">{counts.tasks}</span>}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        <div className="side-card">
          <strong>{channel ? channel.title : 'No channel connected'}</strong>
          {channel ? `${channel.subscribers?.toLocaleString?.() || 0} subscribers` : 'Connect YouTube in Settings to publish.'}
          <div className="pill-row" style={{ marginTop: 8 }}>
            <span className={`chip ${integrations.ai ? 'live' : 'off'}`}>{integrations.ai ? 'Gemini live' : 'Gemini key missing'}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h2>{NAV.find((n) => n.id === tab)?.label}</h2>
            <p>
              {tab === 'agent' && 'Tell the agent what to do — it runs the workflow on authorized media.'}
              {tab === 'dashboard' && 'Live state of your autonomous channel operations.'}
              {tab === 'projects' && 'Long-form sources the agent has analyzed.'}
              {tab === 'shorts' && 'Every generated Short with real rendered MP4 files.'}
              {tab === 'approvals' && 'Nothing publishes without your explicit confirmation.'}
              {tab === 'schedule' && 'Queued YouTube uploads and their publish times.'}
              {tab === 'tasks' && 'Background queue: pause, resume, cancel, retry.'}
              {tab === 'settings' && 'Channel, preferences and agent memory.'}
            </p>
          </div>
          <div className="top-actions">
            {channel && <span className="chip"><img src={channel.thumbnail} alt="" />{channel.handle || channel.title}</span>}
            <span className={`chip ${integrations.youtube ? 'live' : 'off'}`}>{integrations.youtube ? 'YouTube ready' : 'YouTube not configured'}</span>
            <button className="btn sm ghost" onClick={refresh}>Refresh</button>
          </div>
        </div>

        {loadError && <div className="notice err" style={{ marginBottom: 14 }}>{loadError}</div>}

        {!state ? (
          <div className="empty">Loading agent state…</div>
        ) : (
          <>
            {tab === 'agent' && <Chat state={state} refresh={refresh} toast={toast} goto={setTab} />}
            {tab === 'dashboard' && <Dashboard state={state} refresh={refresh} toast={toast} goto={setTab} />}
            {tab === 'projects' && <Projects state={state} refresh={refresh} toast={toast} goto={setTab} />}
            {tab === 'shorts' && <ShortsView state={state} refresh={refresh} toast={toast} mode="all" />}
            {tab === 'approvals' && <ShortsView state={state} refresh={refresh} toast={toast} mode="approvals" />}
            {tab === 'schedule' && <ShortsView state={state} refresh={refresh} toast={toast} mode="schedule" />}
            {tab === 'tasks' && <Tasks state={state} refresh={refresh} toast={toast} />}
            {tab === 'settings' && <Settings state={state} refresh={refresh} toast={toast} />}
          </>
        )}
      </main>

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}

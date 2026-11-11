import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const FIELDS = [
  { key: 'shortDuration', label: 'Preferred Short duration', type: 'select', options: ['15', '20', '30', '45', '60', '90'] },
  { key: 'captionStyle', label: 'Caption style', type: 'select', options: ['bold-highlight', 'clean', 'karaoke'] },
  { key: 'language', label: 'Preferred language', type: 'select', options: ['en', 'es', 'pt', 'fr', 'de', 'hi', 'ar', 'id', 'ja'] },
  { key: 'aspectRatio', label: 'Aspect ratio', type: 'select', options: ['9:16', '1:1', '16:9'] },
  { key: 'uploadTime', label: 'Preferred upload time', type: 'time' },
  { key: 'category', label: 'Preferred category id', type: 'text' },
  { key: 'watermark', label: 'Watermark text', type: 'text' },
  { key: 'quality', label: 'Render quality', type: 'select', options: ['720p', '1080p'] },
  { key: 'shortsPerVideo', label: 'Shorts per video', type: 'select', options: ['3', '5', '8', '10'] },
];

const MODES = [
  { id: 'A', title: 'Auto create', text: 'Analyze, cut, caption and optimize automatically. Nothing is uploaded without a separate confirmation.' },
  { id: 'B', title: 'Auto create + approval', text: 'Everything is generated, then each clip waits for your approval before publishing.' },
  { id: 'C', title: 'Scheduled content', text: 'Prepare clips and schedule publishing times. YouTube requires private visibility until the scheduled moment.' },
];

export default function Settings({ state, refresh, toast }) {
  const [prefs, setPrefs] = useState(state.preferences || {});
  const [memories, setMemories] = useState([]);
  const [memoryText, setMemoryText] = useState('');
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPrefs(state.preferences || {});
  }, [state.preferences]);

  useEffect(() => {
    api.memories().then((r) => setMemories(r.memories || [])).catch(() => {});
    api.config().then(setConfig).catch(() => {});
  }, []);

  const save = async (patch) => {
    setBusy(true);
    try {
      const next = { ...prefs, ...patch };
      await api.savePreferences(next);
      setPrefs(next);
      toast('Preferences saved. The agent uses them on the next run.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    try {
      const res = await api.youtubeConnect();
      if (res?.url) window.location.href = res.url;
      else toast(res?.error || 'Google OAuth is not configured yet.', 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect the YouTube channel and revoke the stored token?')) return;
    try {
      await api.youtubeDisconnect();
      toast('Channel disconnected and token revoked.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const addMemory = async () => {
    if (!memoryText.trim()) return;
    try {
      await api.addMemory(memoryText.trim());
      setMemoryText('');
      const r = await api.memories();
      setMemories(r.memories || []);
      toast('Preference remembered.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const removeMemory = async (id) => {
    try {
      await api.deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const channel = state.channel;
  const ai = state.integrations?.ai;
  const yt = state.integrations?.youtube;

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <h3>Connected YouTube channel</h3>
        {channel ? (
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <div className="hstack">
              {channel.avatar_url && <img src={channel.avatar_url} alt="" width="40" height="40" style={{ borderRadius: '50%' }} />}
              <div>
                <strong>{channel.title || channel.channel_id}</strong>
                <div className="small muted">{channel.channel_id}{channel.handle ? ` · ${channel.handle}` : ''}</div>
                {channel.subscriber_count != null && <div className="small muted">{channel.subscriber_count} subscribers</div>}
              </div>
            </div>
            <button className="btn sm danger" onClick={disconnect}>Disconnect</button>
          </div>
        ) : (
          <div className="hstack" style={{ justifyContent: 'space-between' }}>
            <p className="small muted" style={{ margin: 0 }}>
              No channel connected. Publishing needs official Google OAuth with the youtube.upload scope.
            </p>
            <button className="btn primary" onClick={connect} disabled={!yt}>Connect YouTube</button>
          </div>
        )}
        {!yt && (
          <div className="notice warn mt small">
            Set <code>YOUTUBE_CLIENT_ID</code> and <code>YOUTUBE_CLIENT_SECRET</code> in Settings → Environment variables to enable OAuth.
            Redirect URI: <code>{config?.redirectUri || '/api/youtube/callback'}</code>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Automation mode</h3>
        <div className="modes">
          {MODES.map((m) => (
            <button
              key={m.id}
              className={`mode ${prefs.approvalMode === m.id ? 'active' : ''}`}
              onClick={() => save({ approvalMode: m.id })}
              disabled={busy}
            >
              <span className="tag">MODE {m.id}</span>
              <strong>{m.title}</strong>
              <span className="small muted">{m.text}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Agent preferences</h3>
        <div className="prefs-grid">
          {FIELDS.map((f) => (
            <div key={f.key} className="form-row">
              <label className="field">{f.label}</label>
              {f.type === 'select' ? (
                <select value={prefs[f.key] ?? ''} onChange={(e) => setPrefs({ ...prefs, [f.key]: e.target.value })}>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type={f.type}
                  value={prefs[f.key] ?? ''}
                  onChange={(e) => setPrefs({ ...prefs, [f.key]: e.target.value })}
                />
              )}
            </div>
          ))}
        </div>
        <button className="btn primary mt" onClick={() => save(prefs)} disabled={busy}>Save preferences</button>
      </div>

      <div className="card">
        <h3>Agent memory</h3>
        <p className="small muted">Facts the agent keeps between runs — for example your channel style or banned words.</p>
        <div className="hstack mt">
          <input
            type="text"
            placeholder="e.g. Always use the hook 'Wait for it…' and never mention prices"
            value={memoryText}
            onChange={(e) => setMemoryText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMemory()}
          />
          <button className="btn" onClick={addMemory}>Remember</button>
        </div>
        <div className="list mt">
          {memories.length === 0 && <div className="empty">Nothing remembered yet.</div>}
          {memories.map((m) => (
            <div key={m.id} className="row">
              <span className="grow small">{m.text}</span>
              <button className="btn sm ghost" onClick={() => removeMemory(m.id)}>Forget</button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>Integrations</h3>
        <dl className="kv">
          <dt>AI reasoning</dt>
          <dd>{ai ? 'Gemini connected' : 'Not configured — local heuristic analysis is used and labelled as such'}</dd>
          <dt>YouTube publishing</dt>
          <dd>{yt ? 'Google OAuth configured' : 'Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET'}</dd>
          <dt>Video engine</dt>
          <dd>FFmpeg {config?.ffmpeg || ''} (local, real renders)</dd>
          <dt>Storage</dt>
          <dd>SQLite + local media directory</dd>
          <dt>Session protection</dt>
          <dd>{config?.passwordProtected ? 'Password required' : 'Open (set APP_PASSWORD to lock)'}</dd>
        </dl>
      </div>
    </div>
  );
}

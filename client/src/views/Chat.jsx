import React, { useEffect, useRef, useState } from 'react';
import { api, fmtTime } from '../api.js';
import ShortDetail from '../components/ShortDetail.jsx';

const EXAMPLES = [
  'Turn this long video into five YouTube Shorts and prepare them for my channel',
  'Find the most emotional moments',
  'Create motivational clips',
  'Generate titles and descriptions',
  'Prepare tomorrow\u2019s uploads',
  'Show me all videos waiting for approval',
  'Upload the approved Short',
];

export default function Chat({ state, refresh, toast, goto }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [openShort, setOpenShort] = useState(null);
  const endRef = useRef(null);

  const load = async () => {
    try {
      const res = await api.chat();
      setMessages(res.messages || []);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, busy]);

  const send = async (text) => {
    const message = (text ?? input).trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setMessages((prev) => [...prev, { id: `local_${Date.now()}`, role: 'user', content: message, created_at: Date.now() }]);
    try {
      const res = await api.send(message);
      setMessages((prev) => [
        ...prev,
        { id: `reply_${Date.now()}`, role: 'assistant', content: res.reply, actions: res.actions || [], created_at: Date.now() },
      ]);
      await refresh();
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: `err_${Date.now()}`, role: 'assistant', content: `I could not run that: ${err.message}`, created_at: Date.now() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const runAction = (action) => {
    switch (action.type) {
      case 'short':
      case 'publish_preview':
        setOpenShort(action.shortId);
        break;
      case 'job':
        goto('tasks');
        break;
      case 'open_project':
      case 'needs_upload':
        goto('projects');
        break;
      case 'connect_youtube':
        goto('settings');
        break;
      case 'preview':
        setOpenShort(action.shortId);
        break;
      default:
        break;
    }
  };

  const clear = async () => {
    try {
      await api.clearChat();
      setMessages([]);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="chat-wrap">
      <div className="card chat-panel">
        <div className="hstack" style={{ justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0 }}>My YouTube AI Agent</h3>
            <p className="small muted" style={{ margin: '3px 0 0' }}>
              Give a natural-language instruction. The agent runs the authorized workflow and reports real progress.
            </p>
          </div>
          <button className="btn sm ghost" onClick={clear}>Clear</button>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <p>Start with an instruction, for example:</p>
              <div className="list">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="suggestion" onClick={() => send(ex)}>{ex}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`bubble ${m.role}`}>
              <div className="who">{m.role === 'user' ? 'You' : 'My YouTube AI Agent'} · {fmtTime(m.created_at)}</div>
              <div className="text">{m.content}</div>
              {Array.isArray(m.actions) && m.actions.length > 0 && (
                <div className="hstack" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                  {m.actions.map((a, i) => (
                    <button
                      key={`${m.id}_${i}`}
                      className="btn sm ghost"
                      onClick={() => runAction(a)}
                      disabled={a.type === 'error'}
                    >
                      {a.label || a.type}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="bubble assistant"><div className="text muted">Working on it…</div></div>}
          <div ref={endRef} />
        </div>

        <div className="composer">
          <textarea
            rows={2}
            placeholder="e.g. Turn this video into five Shorts and prepare them for my channel — https://youtube.com/watch?v=…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="btn primary" onClick={() => send()} disabled={busy || !input.trim()}>
            {busy ? 'Running…' : 'Send'}
          </button>
        </div>
        <div className="hstack small muted" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          {EXAMPLES.slice(1, 5).map((ex) => (
            <button key={ex} className="chip" onClick={() => send(ex)}>{ex}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ alignSelf: 'start' }}>
        <h3>Agent status</h3>
        <dl className="kv">
          <dt>Channel</dt>
          <dd>{state.channel?.title || 'Not connected'}</dd>
          <dt>Mode</dt>
          <dd>Mode {state.preferences?.approvalMode || 'B'}</dd>
          <dt>AI</dt>
          <dd>{state.integrations?.ai ? 'Gemini' : 'Local heuristics'}</dd>
          <dt>Awaiting approval</dt>
          <dd>{state.counts?.awaiting ?? 0}</dd>
          <dt>Active tasks</dt>
          <dd>{state.stats?.activeJobs ?? 0}</dd>
        </dl>
        <div className="notice mt small">
          The agent only publishes after you approve a clip and confirm the publishing preview. It never asks for your YouTube password.
        </div>
      </div>

      {openShort && (
        <ShortDetail shortId={openShort} onClose={() => setOpenShort(null)} refresh={refresh} toast={toast} />
      )}
    </div>
  );
}

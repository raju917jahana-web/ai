import React, { useEffect, useRef, useState } from 'react';
import { api, fmtDuration, fmtTime } from '../api.js';

export default function Projects({ state, refresh, toast, goto }) {
  const [mode, setMode] = useState('upload');
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [count, setCount] = useState(5);
  const [attestation, setAttestation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState(state.projects || []);
  const fileRef = useRef(null);

  useEffect(() => {
    setProjects(state.projects || []);
  }, [state.projects]);

  const loadAll = async () => {
    try {
      const data = await api.projects();
      setProjects(data.projects || []);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (mode === 'upload' && !file) return toast('Choose a video file first.', 'error');
    if (mode === 'link' && !url.trim()) return toast('Paste an authorized video URL.', 'error');
    if (!attestation) return toast('Confirm you own or are authorized to edit this video.', 'error');

    const form = new FormData();
    form.append('attestation', 'true');
    form.append('count', String(count));
    if (title.trim()) form.append('title', title.trim());
    if (mode === 'upload') form.append('video', file);
    else form.append('sourceUrl', url.trim());

    setBusy(true);
    try {
      const result = await api.createProject(form);
      if (result.requiresUpload) {
        toast('YouTube source needs your original file. Upload it to continue — the agent never downloads protected media.', 'error');
        goto('projects');
      } else if (result.job) {
        toast('Agent started. Analysis and rendering run in the background.', 'success');
      } else {
        toast('Project created.', 'success');
      }
      setFile(null);
      setUrl('');
      setTitle('');
      setAttestation(false);
      if (fileRef.current) fileRef.current.value = '';
      await loadAll();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const attach = async (project) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = async () => {
      const picked = input.files?.[0];
      if (!picked) return;
      const form = new FormData();
      form.append('video', picked);
      form.append('attestation', 'true');
      form.append('count', String(count));
      try {
        await api.attachSource(project.id, form);
        toast('Original file attached. The agent is running.', 'success');
        await loadAll();
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    input.click();
  };

  const run = async (project) => {
    try {
      await api.runProject(project.id, count);
      toast('Agent queued a new run for this project.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const remove = async (project) => {
    if (!window.confirm(`Delete "${project.title}" and its generated clips?`)) return;
    try {
      await api.deleteProject(project.id);
      toast('Project deleted.', 'success');
      await loadAll();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>New autonomous run</h3>
        <div className="tabs" style={{ marginBottom: 14 }}>
          <button className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')}>Upload video</button>
          <button className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>Authorized link</button>
        </div>

        <form onSubmit={submit}>
          {mode === 'upload' ? (
            <div className="form-row">
              <label className="field" htmlFor="file">Original video file (MP4, MOV, MKV, WEBM)</label>
              <input id="file" ref={fileRef} type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </div>
          ) : (
            <div className="form-row">
              <label className="field" htmlFor="url">Authorized source URL (direct video link or your own YouTube video)</label>
              <input id="url" type="url" placeholder="https://example.com/my-talk.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
              <div className="small muted">
                The agent only downloads direct media links you control. For YouTube URLs it verifies ownership through the official
                Data API and asks for your original file instead of bypassing YouTube's restrictions.
              </div>
            </div>
          )}

          <div className="form-row inline">
            <div>
              <label className="field" htmlFor="ptitle">Project title (optional)</label>
              <input id="ptitle" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Keynote — full talk" />
            </div>
            <div>
              <label className="field" htmlFor="pcount">Shorts to generate</label>
              <input id="pcount" type="number" min="1" max="10" value={count} onChange={(e) => setCount(e.target.value)} />
            </div>
          </div>

          <label className="hstack small" style={{ alignItems: 'flex-start', gap: 9 }}>
            <input type="checkbox" checked={attestation} onChange={(e) => setAttestation(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
            <span className="muted">
              I own this video or have explicit permission to edit and republish it. I understand the agent will not bypass DRM,
              paywalls or YouTube download restrictions.
            </span>
          </label>

          <div className="hstack mt">
            <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Starting agent…' : 'Start autonomous workflow'}</button>
            <button className="btn ghost" type="button" onClick={loadAll}>Reload</button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="hstack" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Projects</h3>
          <span className="small muted">{projects.length} total</span>
        </div>
        {projects.length === 0 ? (
          <div className="empty mt">No projects yet. Add an authorized video above.</div>
        ) : (
          <div className="list mt">
            {projects.map((p) => (
              <div key={p.id} className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="title">{p.title}</div>
                  <div className="meta">
                    {p.source_type === 'upload' ? 'Uploaded' : p.source_type === 'youtube' ? 'YouTube' : 'URL'} ·{' '}
                    {fmtDuration(p.duration || 0)} · {p.short_count || 0} shorts · {fmtTime(p.created_at)}
                  </div>
                  {p.error && <div className="notice err small" style={{ marginTop: 6 }}>{p.error}</div>}
                  {p.progress > 0 && p.progress < 100 && (
                    <>
                      <div className="progress" style={{ marginTop: 7 }}><i style={{ width: `${p.progress}%` }} /></div>
                      <div className="small muted" style={{ marginTop: 4 }}>{p.stage}: {p.progress}%</div>
                    </>
                  )}
                </div>
                <div className="actions">
                  <span className={`status ${p.status}`}>{p.status.replace(/_/g, ' ')}</span>
                  {!p.source_path && <button className="btn sm" onClick={() => attach(p)}>Attach file</button>}
                  {p.source_path && <button className="btn sm" onClick={() => run(p)}>Run again</button>}
                  <button className="btn sm ghost" onClick={() => goto('shorts')}>Clips</button>
                  <button className="btn sm danger" onClick={() => remove(p)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

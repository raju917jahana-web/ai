import React, { useState } from 'react';
import { api, fmtTime } from '../api.js';

export default function Tasks({ state, refresh, toast }) {
  const [openJob, setOpenJob] = useState(null);
  const [detail, setDetail] = useState(null);
  const jobs = state.jobs || [];

  const load = async (id) => {
    if (openJob === id) {
      setOpenJob(null);
      setDetail(null);
      return;
    }
    try {
      const payload = await api.job(id);
      setOpenJob(id);
      setDetail(payload);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const act = async (id, action) => {
    try {
      await api.jobAction(id, action);
      toast(`Task ${action} requested.`, 'success');
      await refresh();
      if (openJob === id) {
        const payload = await api.job(id);
        setDetail(payload);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <div className="hstack" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Task queue</h3>
          <span className="small muted">{jobs.length} recent jobs · real progress from the worker</span>
        </div>

        {jobs.length === 0 ? (
          <div className="empty mt">No tasks yet. Start a workflow to see live progress here.</div>
        ) : (
          <div className="list mt">
            {jobs.map((job) => (
              <div key={job.id} className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="title">
                    {job.type.replace(/_/g, ' ')} <span className="muted small">· {job.id}</span>
                  </div>
                  <div className="meta">
                    {job.stage || 'queued'} · attempt {job.attempts}/{job.max_attempts} · {fmtTime(job.created_at)}
                  </div>
                  <div className="meta">{job.message || '—'}</div>
                  {job.error && <div className="notice err small" style={{ marginTop: 6 }}>{job.error}</div>}
                  <div className="progress" style={{ marginTop: 7 }}>
                    <i style={{ width: `${Math.max(2, job.progress || 0)}%` }} />
                  </div>
                </div>
                <div className="actions">
                  <span className={`status ${job.status}`}>{job.status.replace(/_/g, ' ')}</span>
                  {['running', 'queued'].includes(job.status) && (
                    <button className="btn sm" onClick={() => act(job.id, 'pause')}>Pause</button>
                  )}
                  {job.status === 'paused' && <button className="btn sm" onClick={() => act(job.id, 'resume')}>Resume</button>}
                  {['running', 'queued', 'paused', 'pause_requested'].includes(job.status) && (
                    <button className="btn sm danger" onClick={() => act(job.id, 'cancel')}>Cancel</button>
                  )}
                  {['failed', 'cancelled'].includes(job.status) && (
                    <button className="btn sm ok" onClick={() => act(job.id, 'retry')}>Retry</button>
                  )}
                  <button className="btn sm ghost" onClick={() => load(job.id)}>{openJob === job.id ? 'Hide' : 'Logs'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {detail && (
        <div className="card">
          <h3>Log · {detail.job?.id || openJob}</h3>
          <div className="logs">
            {(detail.logs || []).length === 0
              ? 'No log lines yet.'
              : detail.logs.map((line) => (
                  <div key={line.id} className={line.level || 'info'}>
                    [{new Date(line.created_at).toLocaleTimeString()}] {line.message}
                  </div>
                ))}
          </div>
          {detail.job?.result && (
            <pre className="logs mt">{JSON.stringify(detail.job.result, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

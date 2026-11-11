import React, { useMemo, useState } from 'react';
import { api, fmtDuration, fmtTime, mediaUrl } from '../api.js';
import ShortDetail from '../components/ShortDetail.jsx';

const TITLES = {
  all: ['Shorts gallery', 'Every clip the agent rendered with FFmpeg.'],
  approvals: ['Awaiting approval', 'Review the rendered clip and metadata before anything is published.'],
  schedule: ['Scheduled uploads', 'Clips approved and queued for YouTube.'],
};

export default function ShortsView({ state, refresh, toast, mode = 'all' }) {
  const [openId, setOpenId] = useState(null);
  const [projectFilter, setProjectFilter] = useState('');

  const shorts = useMemo(() => {
    const list = state.shorts || [];
    const filtered = list.filter((s) => {
      if (mode === 'approvals') return ['awaiting_approval', 'approved'].includes(s.status);
      if (mode === 'schedule') return ['scheduled', 'publishing', 'uploading'].includes(s.status);
      return true;
    });
    return projectFilter ? filtered.filter((s) => s.project_id === projectFilter) : filtered;
  }, [state.shorts, mode, projectFilter]);

  const projects = state.projects || [];

  const approve = async (short) => {
    try {
      await api.approveShort(short.id, true);
      toast('Clip approved. Publish still requires the final confirmation step.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div>
      <div className="hstack" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h3 style={{ margin: 0 }}>{TITLES[mode][0]}</h3>
          <p className="small muted" style={{ margin: '3px 0 0' }}>{TITLES[mode][1]}</p>
        </div>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} style={{ maxWidth: 280 }}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.title}</option>
          ))}
        </select>
      </div>

      {shorts.length === 0 ? (
        <div className="empty">
          {mode === 'approvals'
            ? 'Nothing waiting for approval right now.'
            : mode === 'schedule'
              ? 'No scheduled uploads yet. Approve a clip and pick a publish time.'
              : 'No Shorts yet. Start an autonomous run from Projects.'}
        </div>
      ) : (
        <div className="shorts-grid">
          {shorts.map((s) => (
            <div key={s.id} className="short-card">
              <div className="thumb" style={s.file_path ? { backgroundImage: `url(${mediaUrl.thumb(s.project_id, s.id)})` } : undefined}>
                {s.file_path && (
                  <button className="play" onClick={() => setOpenId(s.id)} aria-label={`Open ${s.title || 'clip'}`}>
                    <span>▶</span>
                  </button>
                )}
                <span className={`badge status ${s.status}`}>{s.status.replace(/_/g, ' ')}</span>
                <span className="badge" style={{ left: 'auto', right: 8 }}>{fmtDuration(s.duration)}</span>
              </div>
              <div className="body">
                <div className="title">{s.title || `Short #${s.idx}`}</div>
                <div className="small muted">
                  {s.emotion || 'clip'} · {fmtTime(s.created_at)}
                  {s.scheduled_at ? ` · ${fmtTime(s.scheduled_at)}` : ''}
                </div>
                {s.error && <div className="notice err small">{s.error}</div>}
                <div className="foot">
                  <button className="btn sm" onClick={() => setOpenId(s.id)} disabled={!s.file_path}>Open</button>
                  {mode === 'approvals' && s.status === 'awaiting_approval' && (
                    <button className="btn sm ok" onClick={() => approve(s)}>Approve</button>
                  )}
                  {s.published_url && <a className="btn sm ghost" href={s.published_url} target="_blank" rel="noreferrer">YouTube</a>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {openId && <ShortDetail shortId={openId} onClose={() => setOpenId(null)} refresh={refresh} toast={toast} />}
    </div>
  );
}

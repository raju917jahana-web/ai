import React from 'react';
import { fmtDuration, fmtNumber, fmtTime } from '../api.js';

function Stat({ value, label, hint, accent }) {
  return (
    <div className={`card stat ${accent ? 'accent' : ''}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export default function Dashboard({ state, refresh, toast, goto }) {
  const stats = state.stats || {};
  const projects = state.projects || [];
  const shorts = state.shorts || [];
  const jobs = (state.jobs || []).filter((j) => ['running', 'queued', 'paused', 'pause_requested'].includes(j.status));
  const notifications = state.notifications || [];
  const integrations = state.integrations || {};

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid stats">
        <Stat value={stats.projects ?? 0} label="Projects" hint="Long-form sources" />
        <Stat value={stats.analyzed ?? 0} label="Videos analyzed" hint="Real media inspection" />
        <Stat value={stats.shorts ?? 0} label="Shorts generated" hint={`${fmtDuration(stats.totalDuration || 0)} rendered`} accent />
        <Stat value={stats.awaitingApproval ?? 0} label="Awaiting approval" hint="Blocked until you confirm" />
        <Stat value={stats.scheduled ?? 0} label="Scheduled uploads" hint="Queued for YouTube" />
        <Stat value={stats.published ?? 0} label="Published" hint="Live on your channel" />
        <Stat value={stats.failedJobs ?? 0} label="Failed jobs" hint="Retry from Tasks" />
      </div>

      {!integrations.ai && (
        <div className="notice warn">
          <strong>Gemini key not configured.</strong> Analysis still runs with real FFmpeg scene, audio-energy and silence detection,
          but transcripts, moment reasoning and SEO copy fall back to deterministic heuristics. Add <span className="mono">GEMINI_API_KEY</span> in
          Settings → Environment variables to enable full AI reasoning.
        </div>
      )}
      {!integrations.youtube && (
        <div className="notice warn">
          <strong>YouTube publishing is not configured.</strong> Add <span className="mono">YOUTUBE_CLIENT_ID</span> and{' '}
          <span className="mono">YOUTUBE_CLIENT_SECRET</span> to enable Google OAuth and the official Data API upload path. Rendering and
          approval still work locally.
        </div>
      )}

      <div className="grid two">
        <div className="card">
          <h3>Agent activity</h3>
          {jobs.length === 0 ? (
            <div className="empty">No active tasks. Give the agent a video from the Projects tab or the AI Agent chat.</div>
          ) : (
            <div className="list">
              {jobs.map((job) => (
                <div key={job.id} className="row">
                  <div className="grow">
                    <div className="title">
                      {job.type.replace(/_/g, ' ')} <span className="muted small">· {job.stage || job.status}</span>
                    </div>
                    <div className="meta">{job.message || 'Waiting for worker'}</div>
                    <div className="progress" style={{ marginTop: 7 }}>
                      <i style={{ width: `${Math.max(2, job.progress || 0)}%` }} />
                    </div>
                  </div>
                  <span className={`status ${job.status}`}>{job.status.replace(/_/g, ' ')}</span>
                  <button className="btn sm" onClick={() => goto('tasks')}>Open</button>
                </div>
              ))}
            </div>
          )}

          <div className="section-title">
            <h3 style={{ margin: 0 }}>Recent projects</h3>
            <button className="btn sm ghost" onClick={() => goto('projects')}>All projects</button>
          </div>
          {projects.length === 0 ? (
            <div className="empty">No projects yet. Upload an authorized video to start.</div>
          ) : (
            <div className="list">
              {projects.slice(0, 5).map((p) => (
                <div key={p.id} className="row">
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="meta">
                      {p.source_type === 'upload' ? 'Uploaded file' : p.source_type === 'youtube' ? 'YouTube source' : 'Authorized URL'} ·{' '}
                      {fmtDuration(p.duration || 0)} · {p.short_count || 0} shorts
                    </div>
                    {p.progress > 0 && p.progress < 100 && (
                      <div className="progress" style={{ marginTop: 7 }}><i style={{ width: `${p.progress}%` }} /></div>
                    )}
                  </div>
                  <span className={`status ${p.status}`}>{p.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
          <div className="card">
            <h3>Latest Shorts</h3>
            {shorts.length === 0 ? (
              <div className="empty">Generated Shorts will appear here with real MP4 previews.</div>
            ) : (
              <div className="list">
                {shorts.slice(0, 5).map((s) => (
                  <div key={s.id} className="row">
                    <div className="grow">
                      <div className="title">{s.title || 'Untitled clip'}</div>
                      <div className="meta">
                        {fmtDuration(s.duration)} · {s.emotion || 'clip'} · {s.metadata_source || 'metadata pending'}
                      </div>
                    </div>
                    <span className={`status ${s.status}`}>{s.status.replace(/_/g, ' ')}</span>
                  </div>
                ))}
              </div>
            )}
            <button className="btn sm ghost mt" onClick={() => goto('shorts')}>Open gallery</button>
          </div>

          <div className="card">
            <h3>Notifications</h3>
            {notifications.length === 0 ? (
              <div className="empty">No notifications yet.</div>
            ) : (
              <div className="list">
                {notifications.slice(0, 6).map((n) => (
                  <div key={n.id} className="row">
                    <div className="grow">
                      <div className="title">{n.title}</div>
                      <div className="meta">{n.body || n.kind} · {fmtTime(n.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h3>Agent capabilities</h3>
            <dl className="kv">
              <dt>Video analysis</dt><dd>FFmpeg scenes + audio</dd>
              <dt>AI reasoning</dt><dd>{integrations.ai ? 'Gemini live' : 'Heuristic fallback'}</dd>
              <dt>Rendering</dt><dd>FFmpeg 9:16 MP4</dd>
              <dt>Publishing</dt><dd>{integrations.youtube ? 'YouTube Data API' : 'Not configured'}</dd>
              <dt>Storage</dt><dd>SQLite + local media</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

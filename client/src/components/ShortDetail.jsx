import React, { useEffect, useMemo, useState } from 'react';
import { api, fmtDuration, fmtTime, mediaUrl } from '../api.js';

function toLocalInput(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ShortDetail({ shortId, onClose, refresh, toast }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState([]);

  const load = async () => {
    try {
      const payload = await api.short(shortId);
      setData(payload);
      const s = payload.short || payload;
      setForm({
        title: s.title || '',
        description: s.description || '',
        hashtags: (s.hashtags || []).join(' '),
        keywords: (s.keywords || []).join(', '),
        thumbnail_text: s.thumbnail_text || '',
        category: s.category || '',
        pinned_comment: s.pinned_comment || '',
        visibility: s.visibility || 'private',
        scheduled_at: toLocalInput(s.scheduled_at),
      });
      setSelected((s.director || []).filter((r) => r.autoApply).map((r) => `${r.type}:${r.at}`));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortId]);

  const short = data?.short || data;
  const projectId = short?.project_id;
  const transcript = data?.clipTranscript || data?.transcript || '';

  const recommendations = useMemo(() => (Array.isArray(short?.director) ? short.director : []), [short]);

  if (!short || !form) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><strong>Loading clip…</strong><button className="btn sm ghost" onClick={onClose}>Close</button></div>
        </div>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    try {
      await api.updateShort(short.id, {
        ...form,
        hashtags: form.hashtags.split(/[\s,]+/).filter(Boolean),
        keywords: form.keywords.split(',').map((k) => k.trim()).filter(Boolean),
        scheduled_at: form.scheduled_at ? Date.parse(form.scheduled_at) : null,
      });
      toast('Metadata saved.', 'success');
      await load();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleApprove = async () => {
    try {
      await api.approveShort(short.id, short.status !== 'approved' && short.status !== 'scheduled');
      toast(short.status === 'approved' ? 'Approval withdrawn.' : 'Clip approved. Publishing still needs your final confirmation.', 'success');
      await load();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const openPreview = async () => {
    try {
      const payload = await api.preview(short.id);
      setPreview(payload);
      setConfirmPublish(false);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const publish = async () => {
    if (!confirmPublish) return toast('Tick the confirmation box to publish.', 'error');
    setBusy(true);
    try {
      const result = await api.publish(short.id, {
        confirm: true,
        visibility: form.visibility,
        scheduledAt: form.scheduled_at ? Date.parse(form.scheduled_at) : null,
      });
      toast(result?.url ? `Uploaded: ${result.url}` : 'Upload accepted by YouTube. Tracking progress in Tasks.', 'success');
      await load();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const applyDirector = async () => {
    const effects = recommendations.filter((r) => selected.includes(`${r.type}:${r.at}`));
    if (!effects.length) return toast('Select at least one recommendation.', 'error');
    setBusy(true);
    try {
      await api.direct(short.id, effects);
      toast('Director changes queued — the clip will re-render.', 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <strong>{short.title || `Short #${short.idx}`}</strong>
            <div className="small muted">
              {fmtDuration(short.start_sec)} → {fmtDuration(short.end_sec)} · {fmtDuration(short.duration)} clip ·{' '}
              <span className={`status ${short.status}`}>{short.status.replace(/_/g, ' ')}</span>
            </div>
          </div>
          <div className="hstack">
            <button className="btn sm ghost" onClick={load}>Reload</button>
            <button className="btn sm" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="modal-body">
          <div className="video-wrap">
            {short.file_path ? (
              <video controls playsInline poster={mediaUrl.thumb(projectId, short.id)} src={mediaUrl.short(projectId, short.id)} />
            ) : (
              <div className="empty" style={{ aspectRatio: '9/16', display: 'grid', placeItems: 'center' }}>
                {short.error ? short.error : 'Rendering not finished yet.'}
              </div>
            )}

            <div className="hstack mt">
              <button className="btn primary" onClick={toggleApprove} disabled={!short.file_path}>
                {short.status === 'approved' ? 'Withdraw approval' : 'Approve clip'}
              </button>
              <button className="btn" onClick={openPreview} disabled={!short.file_path}>Publishing preview</button>
            </div>

            {short.published_url && (
              <div className="notice ok mt">
                Published: <a href={short.published_url} target="_blank" rel="noreferrer">{short.published_url}</a>
              </div>
            )}
            {short.error && <div className="notice err mt">{short.error}</div>}

            <div className="card mt">
              <h3>Clip facts</h3>
              <dl className="kv">
                <dt>Emotion</dt><dd>{short.emotion || '—'}</dd>
                <dt>Hook score</dt><dd>{short.score ? Number(short.score).toFixed(1) : '—'}</dd>
                <dt>Captions</dt><dd>{short.caption_style || '—'}</dd>
                <dt>Metadata</dt><dd>{short.metadata_source || '—'}</dd>
                <dt>Render</dt><dd>{short.render_ms ? `${(short.render_ms / 1000).toFixed(1)}s` : '—'}</dd>
                <dt>Created</dt><dd>{fmtTime(short.created_at)}</dd>
              </dl>
              {short.reason && <p className="small muted" style={{ marginTop: 8 }}>{short.reason}</p>}
            </div>
          </div>

          <div className="grid" style={{ gap: 14, alignContent: 'start' }}>
            <div className="card">
              <h3>YouTube metadata</h3>
              <div className="form-row">
                <label className="field">Title</label>
                <input type="text" value={form.title} maxLength={100} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="form-row">
                <label className="field">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="form-row inline">
                <div>
                  <label className="field">Hashtags</label>
                  <input type="text" value={form.hashtags} onChange={(e) => setForm({ ...form, hashtags: e.target.value })} />
                </div>
                <div>
                  <label className="field">Thumbnail text</label>
                  <input type="text" value={form.thumbnail_text} onChange={(e) => setForm({ ...form, thumbnail_text: e.target.value })} />
                </div>
              </div>
              <div className="form-row inline">
                <div>
                  <label className="field">Keywords</label>
                  <input type="text" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
                </div>
                <div>
                  <label className="field">Category id</label>
                  <input type="text" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                </div>
              </div>
              <div className="form-row">
                <label className="field">Pinned comment</label>
                <input type="text" value={form.pinned_comment} onChange={(e) => setForm({ ...form, pinned_comment: e.target.value })} />
              </div>
              <div className="form-row inline">
                <div>
                  <label className="field">Visibility</label>
                  <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                    <option value="private">Private</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                </div>
                <div>
                  <label className="field">Schedule (local)</label>
                  <input type="datetime-local" value={form.scheduled_at} onChange={(e) => setForm({ ...form, scheduled_at: e.target.value })} />
                </div>
              </div>
              <button className="btn" onClick={save} disabled={busy}>Save metadata</button>
            </div>

            <div className="card">
              <h3>AI director</h3>
              {recommendations.length === 0 ? (
                <div className="empty">
                  {short.metadata_source === 'heuristic'
                    ? 'Director recommendations need the Gemini key. Analysis and rendering still ran locally.'
                    : 'No recommendations yet for this clip.'}
                </div>
              ) : (
                <div className="list">
                  {recommendations.map((rec) => {
                    const key = `${rec.type}:${rec.at}`;
                    return (
                      <label key={key} className="rec">
                        <input
                          type="checkbox"
                          checked={selected.includes(key)}
                          onChange={(e) =>
                            setSelected((prev) => (e.target.checked ? [...prev, key] : prev.filter((k) => k !== key)))
                          }
                          style={{ width: 'auto' }}
                        />
                        <span>
                          <span className="t">{fmtDuration(rec.at)}</span> <strong>{rec.label}</strong>
                          {rec.autoApply && <span className="pill" style={{ marginLeft: 6 }}>auto-applicable</span>}
                          <span className="muted" style={{ display: 'block' }}>{rec.detail}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <button className="btn mt" onClick={applyDirector} disabled={busy || recommendations.length === 0}>
                Apply approved changes & re-render
              </button>
            </div>

            {preview && (
              <div className="card">
                <h3>Final publishing preview</h3>
                <div className="notice warn">
                  Nothing is uploaded until you confirm below. This is the exact payload sent to the YouTube Data API.
                </div>
                <dl className="kv mt">
                  <dt>Channel</dt><dd>{preview.channel?.title || 'Not connected'}</dd>
                  <dt>Video</dt><dd>{short.file_path ? 'Rendered MP4 ready' : 'Not rendered'}</dd>
                  <dt>Title</dt><dd>{preview.title || form.title}</dd>
                  <dt>Hashtags</dt><dd>{(preview.hashtags || form.hashtags.split(/\s+/)).join(' ')}</dd>
                  <dt>Visibility</dt><dd>{preview.visibility || form.visibility}</dd>
                  <dt>Schedule</dt><dd>{preview.scheduledAt ? fmtTime(preview.scheduledAt) : form.scheduled_at ? fmtTime(Date.parse(form.scheduled_at)) : 'Publish now'}</dd>
                </dl>
                {preview.description && <p className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{preview.description}</p>}
                {(preview.warnings || []).map((w, i) => (
                  <div key={i} className="notice warn small" style={{ marginTop: 8 }}>{w}</div>
                ))}
                <label className="hstack small mt" style={{ alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={confirmPublish} onChange={(e) => setConfirmPublish(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
                  <span className="muted">I authorize this upload to my connected YouTube channel.</span>
                </label>
                <button className="btn primary mt" onClick={publish} disabled={busy || !confirmPublish}>
                  {busy ? 'Uploading…' : 'Confirm and upload'}
                </button>
              </div>
            )}

            {transcript && (
              <div className="card">
                <h3>Clip transcript (grounding)</h3>
                <p className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{transcript}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

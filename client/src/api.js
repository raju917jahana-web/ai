async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? {} : { 'content-type': 'application/json' },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const error = new Error(data?.error || `Request failed (${res.status})`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export const api = {
  authStatus: () => request('/auth/status'),
  login: (password) => request('/auth/login', { method: 'POST', body: { password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  state: () => request('/state'),
  config: () => request('/config'),

  projects: () => request('/projects'),
  project: (id) => request(`/projects/${id}`),
  createProject: (formData) => request('/projects', { method: 'POST', body: formData }),
  attachSource: (id, formData) => request(`/projects/${id}/source`, { method: 'POST', body: formData }),
  runProject: (id, count) => request(`/projects/${id}/run`, { method: 'POST', body: { count } }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  short: (id) => request(`/shorts/${id}`),
  updateShort: (id, patch) => request(`/shorts/${id}`, { method: 'PATCH', body: patch }),
  approveShort: (id, approved = true) => request(`/shorts/${id}/approve`, { method: 'POST', body: { approved } }),
  preview: (id) => request(`/shorts/${id}/preview`),
  publish: (id, body) => request(`/shorts/${id}/publish`, { method: 'POST', body }),
  direct: (id, effects) => request(`/shorts/${id}/director`, { method: 'POST', body: { effects } }),

  jobs: () => request('/jobs'),
  job: (id) => request(`/jobs/${id}`),
  jobAction: (id, action) => request(`/jobs/${id}/${action}`, { method: 'POST', body: {} }),

  chat: () => request('/chat'),
  send: (message) => request('/chat', { method: 'POST', body: { message } }),
  clearChat: () => request('/chat/clear', { method: 'POST', body: {} }),

  preferences: () => request('/preferences'),
  savePreferences: (patch) => request('/preferences', { method: 'PUT', body: patch }),
  memories: () => request('/memories'),
  addMemory: (text) => request('/memories', { method: 'POST', body: { text } }),
  deleteMemory: (id) => request(`/memories/${id}`, { method: 'DELETE' }),

  notificationsRead: () => request('/notifications/read', { method: 'POST', body: {} }),

  youtubeConnect: () => request('/youtube/connect'),
  youtubeStatus: () => request('/youtube/status'),
  youtubeDisconnect: () => request('/youtube/disconnect', { method: 'POST', body: {} }),
};

export const mediaUrl = {
  short: (projectId, shortId) => `/api/media/${projectId}/shorts/${shortId}.mp4`,
  thumb: (projectId, shortId) => `/api/media/${projectId}/thumbs/${shortId}.jpg`,
  source: (projectId) => `/api/media/${projectId}/source`,
};

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return `${m}:${String(rest).padStart(2, '0')}`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(Number(ms)).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtNumber(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

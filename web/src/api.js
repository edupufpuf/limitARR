async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (res.status === 401) throw new Error('unauthenticated');
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const api = {
  me: () => request('/auth/me'),
  version: () => request('/version'),
  setup: (password) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ password }) }),
  login: (password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),

  libraries: () => request('/libraries'),
  syncLibraries: () => request('/libraries/sync', { method: 'POST' }),
  updateLibrary: (id, body) => request(`/libraries/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  users: () => request('/users'),

  overrides: () => request('/overrides'),
  setOverride: (userId, libraryId, body) =>
    request(`/overrides/${userId}/${libraryId}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteOverride: (userId, libraryId) =>
    request(`/overrides/${userId}/${libraryId}`, { method: 'DELETE' }),
  bulkSetOverride: (libraryId, limitOverride, note) =>
    request('/overrides/bulk', { method: 'POST', body: JSON.stringify({ libraryId, limitOverride, note }) }),

  groups: () => request('/groups'),
  createGroup: (name) => request('/groups', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteGroup: (id) => request(`/groups/${id}`, { method: 'DELETE' }),
  setGroupMembers: (id, userIds) =>
    request(`/groups/${id}/members`, { method: 'PUT', body: JSON.stringify({ userIds }) }),
  setGroupOverride: (id, libraryId, limitOverride) =>
    request(`/groups/${id}/overrides/${libraryId}`, { method: 'PUT', body: JSON.stringify({ limitOverride }) }),
  deleteGroupOverride: (id, libraryId) =>
    request(`/groups/${id}/overrides/${libraryId}`, { method: 'DELETE' }),

  quota: () => request('/quota'),
  recalculateQuota: () => request('/quota/recalculate', { method: 'POST' }),
  resetQuota: (userId, libraryId) => request(`/quota/reset/${userId}/${libraryId}`, { method: 'POST' }),
  importSeerrHistory: () => request('/quota/import-seerr-history', { method: 'POST' }),
  decisions: (params = {}) => request(`/decisions?${new URLSearchParams(params)}`),
  stats: () => request('/stats'),

  settings: () => request('/settings'),
  updateSettings: (body) => request('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  testSettings: () => request('/settings/test', { method: 'POST' }),
  webhookInfo: () => request('/webhook/info'),
  configureWebhook: () => request('/webhook/configure', { method: 'POST' }),

  notificationSettings: () => request('/notifications/settings'),
  updateNotificationSettings: (body) =>
    request('/notifications/settings', { method: 'PUT', body: JSON.stringify(body) }),
  notificationLinks: () => request('/notifications/links'),
  setNotificationLink: (userId, body) =>
    request(`/notifications/links/${userId}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteNotificationLink: (userId) => request(`/notifications/links/${userId}`, { method: 'DELETE' }),
  discoverChats: () => request('/notifications/discover'),
  testNotification: (userId) => request(`/notifications/test/${userId}`, { method: 'POST' }),
  testGroupNotification: () => request('/notifications/test-group', { method: 'POST' }),
};

/** Cliente HTTP + WebSocket que replica a API `window.claudePro` do Electron. */

type Unsub = () => void

const ACTOR_KEY = 'hackinvest_actor'

/** Identidade local da sessão. O app não pede e-mail na entrada. */
function actorEmail(): string {
  try {
    const saved = localStorage.getItem(ACTOR_KEY)
      || localStorage.getItem('genesis_licensed_email')
      || localStorage.getItem('claudepro_licensed_email')
      || ''
    if (saved.includes('@')) return saved.trim().toLowerCase()
    const created = `user-${crypto.randomUUID()}@hackinvest.local`
    localStorage.setItem(ACTOR_KEY, created)
    return created
  } catch {
    return 'user-local@hackinvest.local'
  }
}

const listeners = new Map<string, Set<(...args: any[]) => void>>()

function emit(channel: string, payload: any) {
  const set = listeners.get(channel)
  if (!set) return
  for (const cb of set) {
    try { cb(payload) } catch (err) { console.error('[claude-web]', channel, err) }
  }
}

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  })
  return res.json() as Promise<T>
}

let ws: WebSocket | null = null
let wsTimer: ReturnType<typeof setTimeout> | null = null
let wsTicket = ''

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const q = wsTicket ? `?ticket=${encodeURIComponent(wsTicket)}` : ''
  return `${proto}//${location.host}/ws${q}`
}

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try {
    ws = wsTicket
      ? new WebSocket(wsUrl(), [`cw.${wsTicket}`])
      : new WebSocket(wsUrl())
  } catch {
    scheduleWs()
    return
  }
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(String(ev.data))
      if (data?.channel) emit(data.channel, data.payload)
    } catch { /* ignore */ }
  }
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      void refreshSession().then(() => scheduleWs())
      return
    }
    scheduleWs()
  }
  ws.onerror = () => { /* onclose follows */ }
}

function scheduleWs() {
  if (wsTimer) return
  wsTimer = setTimeout(() => {
    wsTimer = null
    connectWs()
  }, 2000)
}

async function refreshSession() {
  const s = await api<{ ok?: boolean; wsTicket?: string }>('/api/session')
  if (s?.wsTicket) wsTicket = s.wsTicket
  return s
}

void refreshSession().then(() => connectWs()).catch(() => scheduleWs())

window.claudePro = {
  appPlatform: 'web',

  brokerStartAuth: async (opts?: { promptLogin?: boolean }) => {
    return api<{ ok: boolean; url?: string; origin?: string; error?: string }>(
      '/api/auth/start',
      { method: 'POST', body: JSON.stringify({ email: actorEmail(), promptLogin: opts?.promptLogin === true }) },
    )
  },
  brokerExchangeCode: (code: string) =>
    api('/api/auth/exchange', { method: 'POST', body: JSON.stringify({ code }) }),
  brokerDisconnect: () => api('/api/auth/disconnect', { method: 'POST' }),
  brokerLogout: () => api('/api/auth/logout', { method: 'POST' }),
  brokerIsConnected: () => api('/api/auth/connected'),
  brokerRestore: () => {
    return api<{ ok: boolean; connected?: boolean; error?: string }>(
      '/api/auth/restore',
      { method: 'POST', body: JSON.stringify({ email: actorEmail() }) },
    )
  },

  sdkBalances: () => api('/api/sdk/balances'),
  sdkActives: (instrument?: 'binary' | 'digital') =>
    api(`/api/sdk/actives?instrument=${instrument ?? 'binary'}`),
  bankrollEvaluate: (payload: { balanceId: number; amount?: number }) =>
    api('/api/sdk/bankroll', { method: 'POST', body: JSON.stringify(payload) }),

  botStart: (config: any) =>
    api('/api/bot/start', { method: 'POST', body: JSON.stringify(config) }),
  botStop: () => api('/api/bot/stop', { method: 'POST' }),
  botGetStatus: () => api('/api/bot/status'),
  botChartSnapshot: () => api('/api/bot/chart-snapshot'),

  appGetVersion: () => api('/api/version'),
  appSetLocale: (locale: string) =>
    api('/api/locale', { method: 'POST', body: JSON.stringify({ locale }) }),
  appCheckUpdate: () => api('/api/check-update', { method: 'POST' }),
  appOpenExternal: async (url: string) => {
    try {
      window.open(url, '_blank', 'noopener,noreferrer')
      return { ok: true }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'open_failed' }
    }
  },
  appClearStorage: async () => {
    try { localStorage.clear() } catch { /* ignore */ }
    location.reload()
    return { ok: true }
  },
  setUserEmail: (email: string) =>
    api('/api/user/email', { method: 'POST', body: JSON.stringify({ email }) }),
  appGetUserId: () => api('/api/user'),
  appGetEmbedOrigin: () => api('/api/embed-origin'),

  on: (channel: string, cb: (...args: any[]) => void): Unsub => {
    let set = listeners.get(channel)
    if (!set) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(cb)
    return () => { set!.delete(cb) }
  },
}

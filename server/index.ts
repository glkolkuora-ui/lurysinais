import http from 'http'
import path from 'path'
import fs from 'fs'
import express from 'express'
import cookieParser from 'cookie-parser'
import { WebSocketServer } from 'ws'
import { FEATURE_FLAGS } from './engine/feature-flags'
import { tApp } from './engine/locale'
import { pingDb } from './engine/db'
import {
  checkUpdate,
  clearNotifications,
  listNotifications,
  markNotificationRead,
  verifyLicense,
} from './engine/db-ops'
import {
  attachClient,
  createSession,
  emitBrokerConnected,
  ensureBroker,
  getSession,
  getSessionByTicket,
  persistSessionTokens,
  setSessionEmail,
  setSessionLocale,
  startBot,
  stopBot,
  forgetBroker,
  evaluateSessionBankroll,
  type Session,
} from './session-store'

function popupCopy(locale: string) {
  if (locale === 'en') {
    return {
      connected: 'Connected. Closing this window...',
      close: 'You can close this window and go back to Lury Sinais.',
      expired: 'Session expired. Close this window and sign in to Lury Sinais again.',
      opening: 'Opening the broker login in this window…',
      startFail: 'Could not start login',
      redirect: 'Redirecting to the broker…',
      openFail: 'Could not open the login',
    }
  }
  if (locale === 'pt') {
    return {
      connected: 'Conectado. Fechando este pop-up...',
      close: 'Pode fechar este pop-up e voltar ao Lury Sinais.',
      expired: 'Sessão expirada. Feche este pop-up e entre de novo no Lury Sinais.',
      opening: 'Abrindo o login da corretora neste pop-up…',
      startFail: 'Falha ao iniciar o login',
      redirect: 'Redirecionando para a corretora…',
      openFail: 'Não foi possível abrir o login',
    }
  }
  return {
    connected: 'Conectado. Cerrando esta ventana...',
    close: 'Puedes cerrar esta ventana y volver a Lury Sinais.',
    expired: 'Sesión expirada. Cierra esta ventana y entra de nuevo en Lury Sinais.',
    opening: 'Abriendo el login del broker en esta ventana…',
    startFail: 'No se pudo iniciar el login',
    redirect: 'Redirigiendo al broker…',
    openFail: 'No se pudo abrir el login',
  }
}

function popupLang(locale: string): string {
  if (locale === 'en') return 'en'
  if (locale === 'es') return 'es'
  return 'pt-BR'
}

const COOKIE = 'cw_sid'
const EMAIL_COOKIE = 'cw_email'
const PORT = Number(process.env.PORT || 3000)
const VERSION = process.env.npm_package_version ?? '1.0.0'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function sessionCookie() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  }
}

function persistEmail(res: express.Response, email: string) {
  const clean = email.trim().toLowerCase()
  if (EMAIL_RE.test(clean)) res.cookie(EMAIL_COOKIE, clean, sessionCookie())
}

function persistWsTicket(res: express.Response, ticket: string) {
  res.cookie('cw_ticket', ticket, {
    ...sessionCookie(),
    httpOnly: false,
  })
}

function publicOrigin(req: express.Request): string {
  const xfProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
  const proto = xfProto || req.protocol || 'https'
  const xfHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()
  const host = xfHost || req.get('host') || 'localhost'
  return `${proto}://${host}`
}

const app = express()
app.set('trust proxy', 1)
app.set('etag', false)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  next()
})

function extractOAuthCode(raw: string): string | null {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    const code = u.searchParams.get('code')
    if (code) return code
  } catch { /* not a URL */ }
  const match = trimmed.match(/[?&]code=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : trimmed
}

function requireSession(req: express.Request, res: express.Response): Session | null {
  let sid = String(req.cookies?.[COOKIE] ?? '')
  let session = getSession(sid)
  if (!session) {
    session = createSession()
    sid = session.id
    res.cookie(COOKIE, sid, sessionCookie())
  }
  const emailFromCookie = String(req.cookies?.[EMAIL_COOKIE] ?? '').trim().toLowerCase()
  if (!session.email && EMAIL_RE.test(emailFromCookie)) {
    session.email = emailFromCookie
  }
  if (session.email) session.sdk.setUserEmail(session.email)
  persistWsTicket(res, session.wsTicket)
  if (session.email && !session.sdk.isConnected() && !session.reauthRequired) {
    void ensureBroker(session).catch((err) => {
      console.warn('[BROKER] restore em background falhou:', err?.message ?? err)
    })
  }
  return session
}

app.get('/api/health', async (_req, res) => {
  const db = await pingDb()
  res.json({ ok: true, service: 'genesis', db })
})

app.get('/api/session', (req, res) => {
  const session = requireSession(req, res)!
  res.json({
    ok: true,
    connected: session.sdk.isConnected(),
    running: session.bot.isRunning(),
    wsTicket: session.wsTicket,
  })
})

app.get('/api/version', (_req, res) => {
  res.json({ version: VERSION, platform: 'web' })
})

app.post('/api/auth/start', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    const email = String(req.body?.email ?? session.email ?? '').trim().toLowerCase()
    if (EMAIL_RE.test(email)) {
      session.email = email
      session.sdk.setUserEmail(email)
      persistEmail(res, email)
    }
    if (!session.email) {
      const fallback = `user-${session.id.slice(0, 16)}@hackinvest.local`
      session.email = fallback
      session.sdk.setUserEmail(fallback)
      persistEmail(res, fallback)
    }
    if (!session.userId) {
      await setSessionEmail(session, session.email).catch(() => {})
    }
    session.sdk.setRedirectUri('https://claudepro.online/claudeplus/auth/callback')
    const promptLogin = req.body?.promptLogin === true
    const { url, codeVerifier } = await session.sdk.createAuthUrl({ promptLogin })
    session.verifier = codeVerifier
    res.json({ ok: true, url, origin: publicOrigin(req) })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? 'auth_start_failed' })
  }
})

app.post('/api/auth/restore', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    const email = String(req.body?.email ?? session.email ?? '').trim().toLowerCase()
    if (EMAIL_RE.test(email)) {
      session.email = email
      session.sdk.setUserEmail(email)
      persistEmail(res, email)
      if (!session.userId) await setSessionEmail(session, email)
    }
    if (!session.sdk.isConnected() && !session.reauthRequired) {
      await ensureBroker(session)
    }
    const connected = session.sdk.isConnected()
    if (connected) emitBrokerConnected(session)
    res.json({ ok: true, connected })
  } catch (e: any) {
    res.json({ ok: false, connected: false, error: e?.message ?? 'restore_failed' })
  }
})

app.post('/api/auth/exchange', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    const raw = String(req.body?.code ?? '')
    const code = extractOAuthCode(raw)
    if (!code) return res.json({ ok: false, error: tApp('urlNoCode') })
    if (!session.verifier) return res.json({ ok: false, error: tApp('authStartFirst') })
    await session.sdk.exchangeCode(code, session.verifier)
    await session.sdk.connect()
    session.verifier = null
    session.reauthRequired = false
    session.brokerLinked = true
    if (session.email && !session.userId) await setSessionEmail(session, session.email)
    await persistSessionTokens(session)
    emitBrokerConnected(session)
    res.json({ ok: true })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? 'exchange_failed' })
  }
})

app.get('/auth/callback', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    if (req.query.error) {
      return res.redirect(`/?auth=denied`)
    }
    const code = extractOAuthCode(String(req.query.code ?? req.query.raw ?? ''))
    if (!code) return res.redirect('/?auth=missing_code')
    if (!session.verifier) return res.redirect('/?auth=no_verifier')
    await session.sdk.exchangeCode(code, session.verifier)
    await session.sdk.connect()
    session.verifier = null
    session.reauthRequired = false
    session.brokerLinked = true
    if (session.email && !session.userId) await setSessionEmail(session, session.email)
    await persistSessionTokens(session)
    emitBrokerConnected(session)
    const origin = publicOrigin(req)
    const copy = popupCopy(session.locale)
    res.type('html').send(`<!doctype html>
<html lang="${popupLang(session.locale)}"><head><meta charset="utf-8"><title>Lury Sinais</title></head>
<body style="background:#000000;color:#e2e4ea;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<p id="msg">${copy.connected}</p>
<script>
  try { localStorage.setItem('cw_broker_auth', JSON.stringify({ ok: true, t: Date.now() })) } catch (e) {}
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ channel: 'broker:connected' }, ${JSON.stringify(origin)})
      window.opener.focus()
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage({ channel: 'broker:connected' }, ${JSON.stringify(origin)})
    }
  } catch (e) {}
  window.close()
  setTimeout(function () {
    document.getElementById('msg').textContent = ${JSON.stringify(copy.close)}
  }, 400)
</script>
</body></html>`)
  } catch (e: any) {
    console.error('[auth/callback]', e?.message ?? e)
    res.redirect('/?auth=error')
  }
})

app.get('/auth/broker-popup', (req, res) => {
  const session = getSession(String(req.cookies?.[COOKIE] ?? ''))
  const expired = popupCopy('pt')
  if (!session) {
    res.status(401).type('html').send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Lury Sinais</title></head>
<body style="margin:0;background:#000000;color:#e2e4ea;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh">
<p>${expired.expired}</p>
</body></html>`)
    return
  }
  const copy = popupCopy(session.locale)
  res.type('html').send(`<!doctype html>
<html lang="${popupLang(session.locale)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lury Sinais</title>
  <style>
    html,body{margin:0;height:100%;background:#000000;color:#e2e4ea;font-family:system-ui,sans-serif}
    .wrap{min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;text-align:center}
    h1{margin:0;font-size:18px;font-weight:700}
    p{margin:0;color:#9196a8;font-size:14px;line-height:1.5;max-width:280px}
    .spin{width:28px;height:28px;border:3px solid #1f2330;border-top-color:#22c55e;border-radius:50%;animation:s .8s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    .err{color:#f87171}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="spin" aria-hidden="true"></div>
    <h1>Lury Sinais</h1>
    <p id="msg">${copy.opening}</p>
  </div>
  <script>
    const msg = document.getElementById('msg')
    async function go() {
      try {
        const res = await fetch('/api/auth/start', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ promptLogin: true })
        })
        const data = await res.json()
        if (!data || !data.ok || !data.url) {
          throw new Error(data && data.error ? data.error : ${JSON.stringify(copy.startFail)})
        }
        msg.textContent = ${JSON.stringify(copy.redirect)}
        const bounce = new URL('https://claudepro.online/claudeplus/auth/callback/')
        bounce.searchParams.set('web_return', location.origin)
        bounce.searchParams.set('auth_url', data.url)
        location.replace(bounce.toString())
      } catch (err) {
        msg.className = 'err'
        msg.textContent = err && err.message ? err.message : ${JSON.stringify(copy.openFail)}
      }
    }
    go()
  </script>
</body>
</html>`)
})

app.get('/api/auth/connected', (req, res) => {
  const session = requireSession(req, res)!
  res.json({ connected: session.sdk.isConnected() })
})

app.post('/api/auth/logout', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    await session.bot.stop().catch(() => {})
    await forgetBroker(session)
    res.json({ ok: true })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? 'logout_failed' })
  }
})

app.post('/api/auth/disconnect', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    await session.sdk.disconnect()
    res.json({ ok: true })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message ?? 'disconnect_failed' })
  }
})

app.get('/api/sdk/balances', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    if (!session.sdk.isConnected()) await ensureBroker(session)
    res.json({ ok: true, balances: await session.sdk.getBalances() })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

app.post('/api/sdk/bankroll', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    if (!session.sdk.isConnected()) await ensureBroker(session)
    const balanceId = Number(req.body?.balanceId)
    if (!Number.isFinite(balanceId) || balanceId <= 0) {
      res.json({ ok: false, error: tApp('balanceNotFound') })
      return
    }
    const balances = await session.sdk.getBalances()
    const bal = balances.find((b) => String(b.id) === String(balanceId))
    if (!bal) {
      res.json({ ok: false, error: tApp('balanceNotFound') })
      return
    }
    const gate = await evaluateSessionBankroll(session, balanceId, bal.amount)
    res.json({ ok: true, ...gate, currency: bal.currency })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

app.get('/api/sdk/actives', async (req, res) => {
  const session = requireSession(req, res)!
  const instrument = req.query.instrument === 'digital' ? 'digital' : 'binary'
  try {
    if (!session.sdk.isConnected()) await ensureBroker(session)
    const actives = await session.sdk.getAvailableActives(instrument)
    console.log('[ACTIVES]', instrument, actives.length)
    res.json({ ok: true, actives })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

app.post('/api/bot/start', async (req, res) => {
  const session = requireSession(req, res)!
  res.json(await startBot(session, req.body))
})

app.post('/api/bot/stop', async (req, res) => {
  const session = requireSession(req, res)!
  res.json(await stopBot(session))
})

app.get('/api/bot/status', (req, res) => {
  const session = requireSession(req, res)!
  res.json(session.bot.getStatus())
})

app.get('/api/bot/chart-snapshot', (req, res) => {
  const session = requireSession(req, res)!
  res.json(session.bot.getChartCandles())
})

app.post('/api/locale', (req, res) => {
  const session = requireSession(req, res)!
  const locale = setSessionLocale(session, String(req.body?.locale ?? 'pt'))
  res.json({ ok: true, locale })
})

app.post('/api/user/email', async (req, res) => {
  const session = requireSession(req, res)!
  const result = await setSessionEmail(session, String(req.body?.email ?? ''))
  if (session.email) persistEmail(res, session.email)
  res.json(result)
})

app.post('/api/license/verify', async (req, res) => {
  const session = requireSession(req, res)!
  try {
    const email = String(req.body?.email ?? '')
    const result = await verifyLicense({
      email,
      appVersion: String(req.body?.app_version ?? 'web'),
      clientIp: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    })
    if (result.authorized && result.user_id) {
      session.email = email.trim().toLowerCase()
      session.userId = result.user_id
      session.sdk.setUserEmail(session.email)
      persistEmail(res, session.email)
    }
    res.json(result)
  } catch (e: any) {
    res.json({ authorized: false, message: e?.message ?? 'license_failed' })
  }
})

app.post('/api/notifications/list', async (req, res) => {
  try {
    const userId = typeof req.body?.user_id === 'string' ? req.body.user_id : null
    res.json(await listNotifications(userId))
  } catch (e: any) {
    res.json({ notifications: [], dismissed_keys: [], error: e?.message })
  }
})

app.post('/api/notifications/mark-read', async (req, res) => {
  try {
    res.json(await markNotificationRead({
      userId: typeof req.body?.user_id === 'string' ? req.body.user_id : null,
      notificationId: typeof req.body?.notification_id === 'string' ? req.body.notification_id : undefined,
      itemKey: typeof req.body?.item_key === 'string' ? req.body.item_key : undefined,
    }))
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

app.post('/api/notifications/clear', async (req, res) => {
  try {
    const userId = String(req.body?.user_id ?? '')
    const keys = Array.isArray(req.body?.dismiss_keys)
      ? req.body.dismiss_keys.filter((k: unknown) => typeof k === 'string' && k.length > 0)
      : []
    res.json(await clearNotifications(userId, keys))
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

app.get('/api/user', (req, res) => {
  const session = requireSession(req, res)!
  res.json({ userId: session.userId, email: session.email })
})

app.get('/api/embed-origin', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`
  res.json({ origin, pageUrl: `${origin}/` })
})

app.post('/api/check-update', async (_req, res) => {
  if (!FEATURE_FLAGS.UPDATE_CHECK_ENABLED) return res.json({ ok: true, needs_update: false })
  try {
    const result = await checkUpdate('web', VERSION)
    res.json({ ok: true, ...result })
  } catch (e: any) {
    res.json({ ok: false, error: e?.message })
  }
})

const publicDir = path.join(__dirname, 'public')
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir))
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (req.path.startsWith('/api') || req.path.startsWith('/ws') || req.path.startsWith('/auth')) return next()
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

function ticketFromUpgrade(req: http.IncomingMessage): string {
  const proto = String(req.headers['sec-websocket-protocol'] ?? '')
  const fromProto = proto.split(',').map((s) => s.trim()).find((s) => s.startsWith('cw.'))
  if (fromProto) return fromProto.slice(3)
  const rawUrl = String(req.url ?? '')
  const qs = rawUrl.includes('?') ? new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1)) : new URLSearchParams()
  return String(qs.get('ticket') ?? '')
}

wss.on('connection', (ws, req) => {
  const ticket = ticketFromUpgrade(req)
  const cookie = String(req.headers.cookie ?? '')
  const sidMatch = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))
  const ticketMatch = cookie.match(/(?:^|; )cw_ticket=([^;]+)/)
  const sid = sidMatch ? decodeURIComponent(sidMatch[1]) : ''
  const cookieTicket = ticketMatch ? decodeURIComponent(ticketMatch[1]) : ''
  const session = getSessionByTicket(ticket) || getSessionByTicket(cookieTicket) || getSession(sid)
  if (!session) {
    console.warn('[WS] sessão ausente — ticket/cookie não batem')
    ws.close(4401, 'no session')
    return
  }
  attachClient(session, ws)
  ws.send(JSON.stringify({
    channel: 'session:hello',
    payload: { connected: session.sdk.isConnected(), running: session.bot.isRunning() },
  }))
  if (session.bot.isRunning()) {
    ws.send(JSON.stringify({ channel: 'bot:started', payload: session.bot.getStatus() }))
    const candles = session.bot.getChartCandles()
    if (candles.length) {
      ws.send(JSON.stringify({ channel: 'bot:candles_history', payload: candles }))
    }
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[genesis] listening on :${PORT}`)
})

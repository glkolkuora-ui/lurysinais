import { useState, useEffect, useCallback, useRef } from 'react'
import type { BotStatus, BalanceInfo, TradeRecord, BotConfig } from '../types'
import ConfigPanel from '../components/ConfigPanel'
import ScoreBoard from '../components/ScoreBoard'
import TradeLog from '../components/TradeLog'
import DesignChart, { type ChartQuote } from '../components/DesignChart'
import LogConsole from '../components/LogConsole'
import { formatCurrency } from '../lib/currency'
import { useI18n } from '../i18n/I18nProvider'
import '../styles/trade-home.css'

const BROKER_ORIGIN = 'https://claudepro.online'

function openBrokerPopup(): Window | null {
  const w = 480
  const h = 740
  const left = Math.round(window.screenX + (window.outerWidth - w) / 2)
  const top = Math.round(window.screenY + (window.outerHeight - h) / 2)
  return window.open(
    '/auth/broker-popup',
    'genesis_broker_auth',
    `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,status=no,scrollbars=yes,resizable=yes`,
  )
}

export default function Operacoes() {
  const { t, bcp47 } = useI18n()
  const tRef = useRef(t)
  tRef.current = t
  const [balances, setBalances] = useState<BalanceInfo[]>([])
  const [status, setStatus] = useState<BotStatus | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [configOpen, setConfigOpen] = useState(false)
  const [activeBalance, setActiveBalance] = useState(0)
  const [displayBalanceId, setDisplayBalanceId] = useState<number | null>(null)
  const [quote, setQuote] = useState<ChartQuote | null>(null)
  const [brokerConnected, setBrokerConnected] = useState(false)
  const [brokerConnecting, setBrokerConnecting] = useState(false)
  const [brokerError, setBrokerError] = useState('')
  const popupRef = useRef<Window | null>(null)

  const addLog = useCallback((msg: string) => setLogs(p => [msg, ...p].slice(0, 200)), [])

  const currency =
    status?.currency
    ?? balances.find(b => b.id === displayBalanceId)?.currency
    ?? balances.find(b => b.id === status?.balanceId)?.currency
    ?? balances.find(b => b.type === 'real' && String(b.currency).toUpperCase() === 'BRL')?.currency
    ?? balances.find(b => b.type === 'real')?.currency
    ?? balances[0]?.currency
    ?? 'BRL'

  const currencyRef = useRef(currency)
  currencyRef.current = currency

  useEffect(() => {
    let cancelled = false
    const syncBroker = async () => {
      try {
        const res = await window.claudePro.brokerIsConnected()
        if (!cancelled) setBrokerConnected(Boolean(res?.connected))
      } catch { /* sessão ainda abrindo */ }
    }
    void window.claudePro.brokerRestore().then((res) => {
      if (!cancelled && res?.connected) setBrokerConnected(true)
    }).catch(() => {})
    void syncBroker()

    const finish = () => {
      setBrokerConnecting(false)
      setBrokerConnected(true)
      setBrokerError('')
      try { sessionStorage.removeItem('cw_need_broker_login') } catch { /* ignore */ }
      try { popupRef.current?.close() } catch { /* ignore */ }
      popupRef.current = null
    }
    const unsubOk = window.claudePro.on('broker:connected', finish)
    const unsubErr = window.claudePro.on('broker:error', (msg: string) => {
      setBrokerConnecting(false)
      setBrokerError(typeof msg === 'string' ? msg : String(msg))
    })
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin === window.location.origin && ev.data?.channel === 'broker:connected') {
        finish()
        return
      }
      if (ev.origin === BROKER_ORIGIN && ev.data?.channel === 'broker:oauth_code' && typeof ev.data.code === 'string') {
        void window.claudePro.brokerExchangeCode(ev.data.code).then((res) => {
          if (res?.ok) finish()
          else {
            setBrokerConnecting(false)
            setBrokerError(res?.error ?? tRef.current('login.authFailed'))
          }
        })
      }
    }
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === 'cw_broker_auth' && ev.newValue) finish()
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('storage', onStorage)
    const brokerPoll = window.setInterval(() => { void syncBroker() }, 2000)

    async function init() {
      const status = await window.claudePro.botGetStatus()
      if (!cancelled && status) setStatus(status)
    }
    void init()

    const unsubs = [
      window.claudePro.on('session:hello', (p: { running?: boolean }) => {
        if (p?.running) {
          void window.claudePro.botGetStatus().then((s) => { if (s) setStatus(s) })
        }
      }),
      window.claudePro.on('bot:status', s => setStatus(s)),
      window.claudePro.on('bot:started', s => { setStatus(s); addLog(tRef.current('ops.logStarted')) }),
      window.claudePro.on('bot:stopped', s => { setStatus(s); setDisplayBalanceId(null); addLog(tRef.current('ops.logStopped')) }),
      window.claudePro.on('bot:trade_entered', (trade: TradeRecord) =>
        addLog(tRef.current('ops.logEntry', { strategy: trade.strategy, direction: trade.direction, amount: formatCurrency(trade.amount, currencyRef.current) }))),
      window.claudePro.on('bot:trade_result', (tr: TradeRecord) =>
        addLog(`[${tr.result}] ${tr.strategy} ${tr.direction} ${tr.profit >= 0 ? '+' : ''}${formatCurrency(tr.profit, currencyRef.current)}`)),
      window.claudePro.on('bot:stop_triggered', (d: any) => {
        const map: Record<string, 'ops.stopReason.stop_loss' | 'ops.stopReason.stop_win' | 'ops.stopReason.consec_losses'> = {
          stop_loss: 'ops.stopReason.stop_loss',
          stop_win: 'ops.stopReason.stop_win',
          consec_losses: 'ops.stopReason.consec_losses',
        }
        const reasonKey = map[String(d.reason)]
        addLog(tRef.current('ops.logStop', { reason: reasonKey ? tRef.current(reasonKey) : String(d.reason ?? '') }))
      }),
      window.claudePro.on('bot:log', (m: string) => addLog(m)),
      window.claudePro.on('bot:balance', (v: number) => setActiveBalance(v)),
      window.claudePro.on('bot:error', (e: string) => addLog(tRef.current('ops.logError', { error: e }))),
    ]
    const poll = window.setInterval(() => {
      void window.claudePro.botGetStatus().then((s) => { if (s) setStatus(s) })
    }, 2000)
    return () => {
      cancelled = true
      unsubOk()
      unsubErr()
      window.removeEventListener('message', onMessage)
      window.removeEventListener('storage', onStorage)
      window.clearInterval(brokerPoll)
      unsubs.forEach(u => u())
      window.clearInterval(poll)
    }
  }, [addLog])

  async function handleBrokerAuth() {
    setBrokerConnecting(true)
    setBrokerError('')
    try { sessionStorage.removeItem('cw_need_broker_login') } catch { /* ignore */ }
    const popup = openBrokerPopup()
    popupRef.current = popup
    if (!popup) {
      setBrokerConnecting(false)
      setBrokerError(t('login.popupBlocked'))
      return
    }
    try { popup.focus() } catch { /* ignore */ }
  }

  async function handleStart(config: BotConfig) {
    setConfigOpen(false)
    const res = await window.claudePro.botStart(config)
    const statusRes = (res as any)?.status ?? await window.claudePro.botGetStatus()
    if (statusRes) setStatus(statusRes)
    if (!res.ok) addLog(t('ops.logError', { error: res.error ?? '' }))
    else setDisplayBalanceId(config.balanceId)
  }

  async function handleStop() {
    await window.claudePro.botStop()
    const s = await window.claudePro.botGetStatus()
    if (s) setStatus(s)
  }

  async function openConfig() {
    setConfigOpen(true)
    try {
      const bRes = await window.claudePro.sdkBalances()
      if (bRes.ok && bRes.balances) setBalances(bRes.balances)
      else addLog(t('ops.logError', { error: bRes.error ?? t('ops.noBalance') }))
    } catch (err: any) {
      addLog(t('ops.logError', { error: err?.message ?? t('ops.noBalance') }))
    }
  }

  const isRunning = status?.running ?? false
  const priceText = quote
    ? quote.price.toLocaleString(bcp47, {
      minimumFractionDigits: quote.price >= 100 ? 2 : 5,
      maximumFractionDigits: quote.price >= 100 ? 2 : 5,
    })
    : '—'
  const changeText = quote
    ? `${quote.changePct >= 0 ? '+' : ''}${quote.changePct.toFixed(2).replace('.', ',')}%`
    : ''

  return (
    <div className="trade-home-shell">
      <div className="trade-home">
        <div className="th-head">
          <span className="th-icon-btn" aria-hidden />
          <div className="th-asset">
            <span className="th-asset-btn">
              <span>{status?.activeTicker || t('ops.idle')}</span>
            </span>
          </div>
          <span className="th-icon-btn" aria-hidden />
        </div>

        <div className="th-price">
          <span className="th-price-val">{priceText}</span>
          {quote && (
            <span className={quote.changePct >= 0 ? 'th-chg up' : 'th-chg down'}>{changeText}</span>
          )}
        </div>

        <DesignChart onQuote={setQuote} />

        <div className="th-trade">
          <div className="th-signal">
            {!brokerConnected && !isRunning ? (
              <div className="th-ai-wrap">
                <button
                  type="button"
                  className="th-ai"
                  onClick={() => void handleBrokerAuth()}
                  disabled={brokerConnecting}
                >
                  <span className="th-ai-glow" aria-hidden />
                  <span className="th-ai-shine" aria-hidden />
                  <span className="th-ai-inner">
                    <span className="th-ai-label th-ai-label-long">
                      {brokerConnecting ? t('login.connectingTitle') : t('login.enter')}
                    </span>
                  </span>
                </button>
                <p className="th-ai-hint">{brokerError || t('ops.connectHint')}</p>
              </div>
            ) : !isRunning ? (
              <div className="th-ai-wrap">
                <button
                  type="button"
                  className="th-ai"
                  onClick={() => void openConfig()}
                >
                  <span className="th-ai-glow" aria-hidden />
                  <span className="th-ai-shine" aria-hidden />
                  <span className="th-ai-inner">
                    <span className="th-ai-label">{t('ops.configure')}</span>
                  </span>
                </button>
                <p className="th-ai-hint">{t('ops.configureHint')}</p>
              </div>
            ) : (
              <div className="th-ai-wrap">
                <button type="button" className="th-ai th-ai-stop" onClick={() => void handleStop()}>
                  <span className="th-ai-inner">
                    <span className="th-ai-label">{t('ops.stop')}</span>
                  </span>
                </button>
                <p className="th-ai-hint">{status?.activeTicker} · {t('ops.live')}</p>
              </div>
            )}
          </div>
        </div>

        <div className="th-bot-extra">
          <ScoreBoard status={status} activeBalance={activeBalance} currency={currency} />
          <TradeLog trades={status?.trades ?? []} currency={currency} />
          <LogConsole logs={logs} />
        </div>
      </div>

      {configOpen && (
        <ConfigPanel
          balances={balances}
          onStart={handleStart}
          onClose={() => setConfigOpen(false)}
        />
      )}
    </div>
  )
}

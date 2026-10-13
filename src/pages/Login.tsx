import { useState, useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import LanguageSwitcher from '../components/LanguageSwitcher'

interface Props { onLoggedIn: () => void }
type Step = 'idle' | 'connecting'

const CLAUDE_ORIGIN = 'https://claudepro.online'

function authQueryError(t: (key: any) => string): string | null {
  const raw = new URLSearchParams(window.location.search).get('auth')
  if (!raw || raw === 'ok') return null
  if (raw === 'denied') return t('login.authDenied')
  if (raw === 'no_verifier') return t('login.authExpired')
  if (raw === 'missing_code') return t('login.authFailed')
  return t('login.authFailed')
}

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

export default function Login({ onLoggedIn }: Props) {
  const { t } = useI18n()
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const popupRef = useRef<Window | null>(null)
  const finishedRef = useRef(false)

  const onLoggedInRef = useRef(onLoggedIn)
  onLoggedInRef.current = onLoggedIn

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const auth = params.get('auth')
    if (auth && auth !== 'ok') {
      setError(authQueryError(t) ?? t('login.authFailed'))
      window.history.replaceState({}, '', window.location.pathname)
    }

    const finish = () => {
      if (finishedRef.current) return
      finishedRef.current = true
      try { sessionStorage.removeItem('cw_need_broker_login') } catch { /* ignore */ }
      try { popupRef.current?.close() } catch { /* ignore */ }
      popupRef.current = null
      setIsConnecting(false)
      onLoggedInRef.current()
    }

    const unsubOk = window.claudePro.on('broker:connected', finish)
    const unsubErr = window.claudePro.on('broker:error', (msg: string) => {
      setIsConnecting(false)
      setError(typeof msg === 'string' ? msg : String(msg))
      setStep('idle')
    })

    const onMessage = (ev: MessageEvent) => {
      if (ev.origin === window.location.origin && ev.data?.channel === 'broker:connected') {
        finish()
        return
      }
      if (ev.origin === CLAUDE_ORIGIN && ev.data?.channel === 'broker:oauth_code' && typeof ev.data.code === 'string') {
        void window.claudePro.brokerExchangeCode(ev.data.code).then((res) => {
          if (res?.ok) finish()
          else {
            setIsConnecting(false)
            setStep('idle')
            setError(res?.error ?? t('login.authFailed'))
          }
        })
      }
    }
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === 'cw_broker_auth' && ev.newValue) finish()
    }
    window.addEventListener('message', onMessage)
    window.addEventListener('storage', onStorage)

    const forceAuth = (() => {
      try { return sessionStorage.getItem('cw_need_broker_login') === '1' } catch { return false }
    })()

    void window.claudePro.brokerIsConnected().then((res) => {
      if (res.connected && !forceAuth) finish()
    })

    const poll = window.setInterval(() => {
      if (forceAuth) return
      void window.claudePro.brokerIsConnected().then((res) => {
        if (res.connected) finish()
      })
    }, 1500)

    return () => {
      unsubOk()
      unsubErr()
      window.removeEventListener('message', onMessage)
      window.removeEventListener('storage', onStorage)
      window.clearInterval(poll)
    }
  }, [t])

  async function handleLogin() {
    setIsConnecting(true)
    setError('')
    setStep('connecting')

    const savedEmail = (() => {
      try { return localStorage.getItem('genesis_licensed_email') || '' } catch { return '' }
    })()
    if (savedEmail) {
      try { await window.claudePro.setUserEmail(savedEmail) } catch { /* segue */ }
    }

    const popup = openBrokerPopup()
    popupRef.current = popup
    if (!popup) {
      setIsConnecting(false)
      setStep('idle')
      setError(t('login.popupBlocked'))
      return
    }
    try { popup.focus() } catch { /* ignore */ }
  }

  return (
    <div className="login-page">
      <div className="login-orb" aria-hidden />
      <div className={`login-card glass-elevated${isConnecting ? ' login-card-loading' : ''}`}>
        <div className="login-card-accent" aria-hidden />
        {step === 'connecting' || isConnecting ? (
          <div className="login-loading">
            <div className="loading-spinner" aria-hidden />
            <h2>{t('login.connectingTitle')}</h2>
            <p>{t('login.connectingBody')}</p>
            <button
              type="button"
              className="btn-broker-alt"
              onClick={() => {
                try { popupRef.current?.close() } catch { /* ignore */ }
                popupRef.current = null
                setIsConnecting(false)
                setStep('idle')
              }}
            >
              {t('login.back')}
            </button>
          </div>
        ) : (
        <>
        <div className="login-brand">
          <span className="brand-claude">Lory Sinais</span>
        </div>
        <p className="login-tagline">{t('login.tagline')}</p>
        <p className="login-desc">{t('login.desc')}</p>
        {error && <div className="login-error">{error}</div>}
        <button className="btn-broker" onClick={() => void handleLogin()}>
          {t('login.enter')}
        </button>
        </>
        )}
        <div className="login-lang-slot">
          <LanguageSwitcher variant="corner" />
        </div>
      </div>
    </div>
  )
}

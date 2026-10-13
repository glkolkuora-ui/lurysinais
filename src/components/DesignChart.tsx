import { useEffect, useRef, useState } from 'react'
import {
  createChart,
  CandlestickSeries,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useI18n } from '../i18n/I18nProvider'

interface RawCandle {
  from: number
  open: number
  high?: number
  max?: number
  low?: number
  min?: number
  close: number
}

interface Bar {
  time: UTCTimestamp
  open: number
  high: number
  low: number
  close: number
}

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D'] as const
type Timeframe = (typeof TIMEFRAMES)[number]

const BUCKET: Record<Timeframe, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1D': 86400,
}

function toBar(c: RawCandle): Bar | null {
  const time = Number(c?.from)
  if (!Number.isFinite(time)) return null
  const open = Number(c.open)
  const close = Number(c.close)
  const high = Number(c.max ?? c.high ?? close)
  const low = Number(c.min ?? c.low ?? close)
  if (![open, close, high, low].every(Number.isFinite)) return null
  return { time: time as UTCTimestamp, open, high, low, close }
}

function demoBars(count = 96): Bar[] {
  const end = Math.floor(Date.now() / 1000 / 60) * 60
  let close = 1.0864
  const bars: Bar[] = []
  for (let i = count; i >= 1; i -= 1) {
    const open = close
    const wave = Math.sin(i / 9) * 0.0018 + Math.sin(i / 23) * 0.0011
    const tick = (((i * 13) % 89) / 89 - 0.5) * 0.0014
    close = Math.max(1.05, Math.min(1.12, open + wave * 0.35 + tick))
    const body = Math.abs(close - open)
    const wick = 0.00035 + (((i * 7) % 11) / 11) * 0.00055
    const high = Math.max(open, close) + wick
    const low = Math.min(open, close) - wick * 0.8 - body * 0.15
    bars.push({
      time: (end - i * 60) as UTCTimestamp,
      open,
      high,
      low,
      close,
    })
  }
  return bars
}

function aggregate(bars: Bar[], bucketSec: number): Bar[] {
  if (bucketSec <= 60) return bars
  const grouped = new Map<number, Bar>()
  for (const bar of bars) {
    const start = (Math.floor(bar.time / bucketSec) * bucketSec) as UTCTimestamp
    const current = grouped.get(start)
    if (!current) {
      grouped.set(start, { ...bar, time: start })
      continue
    }
    current.high = Math.max(current.high, bar.high)
    current.low = Math.min(current.low, bar.low)
    current.close = bar.close
  }
  return [...grouped.values()]
}

export interface ChartQuote {
  price: number
  changePct: number
}

interface Props {
  onQuote?: (quote: ChartQuote | null) => void
}

export default function DesignChart({ onQuote }: Props) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const seriesRef = useRef<ReturnType<ReturnType<typeof createChart>['addSeries']> | null>(null)
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const m1Ref = useRef(new Map<number, Bar>())
  const liveRef = useRef(false)
  const tfRef = useRef<Timeframe>('1m')
  const onQuoteRef = useRef(onQuote)
  const renderRef = useRef<() => void>(() => {})
  const [tf, setTf] = useState<Timeframe>('1m')
  const [hasBars, setHasBars] = useState(true)

  onQuoteRef.current = onQuote
  tfRef.current = tf

  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current

    const measure = () => ({
      width: Math.max(el.clientWidth || el.parentElement?.clientWidth || 0, 280),
      height: Math.max(el.clientHeight || el.parentElement?.clientHeight || 0, 240),
    })

    const chart = createChart(el, {
      autoSize: false,
      ...measure(),
      layout: {
        background: { color: '#000000' },
        textColor: '#9b8aaf',
      },
      grid: {
        vertLines: { color: '#1a3a24' },
        horzLines: { color: '#1a3a24' },
      },
      rightPriceScale: { borderColor: '#2e1a4a' },
      timeScale: {
        borderColor: '#2e1a4a',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 7,
        fixRightEdge: true,
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceFormat: { type: 'price', precision: 5, minMove: 0.00001 },
    })

    chartRef.current = chart
    seriesRef.current = series

    const seedDemo = () => {
      liveRef.current = false
      m1Ref.current.clear()
      for (const bar of demoBars()) m1Ref.current.set(bar.time, bar)
    }

    const render = () => {
      const current = seriesRef.current
      if (!current) return
      const bars = [...m1Ref.current.values()].sort((a, b) => a.time - b.time)
      const view = aggregate(bars, BUCKET[tfRef.current])
      current.setData(view)
      setHasBars(view.length > 0)
      if (!view.length) {
        onQuoteRef.current?.(null)
        return
      }
      const last = view[view.length - 1]
      const first = view[0]
      const base = first.open || last.close
      const changePct = base ? ((last.close - base) / base) * 100 : 0
      current.applyOptions({
        priceFormat: last.close >= 100
          ? { type: 'price', precision: 2, minMove: 0.01 }
          : { type: 'price', precision: 5, minMove: 0.00001 },
      })
      if (liveRef.current) chartRef.current?.timeScale().scrollToRealTime()
      else chartRef.current?.timeScale().fitContent()
      onQuoteRef.current?.({ price: last.close, changePct })
    }
    renderRef.current = render

    const paintLive = (candles: unknown) => {
      const list = Array.isArray(candles) ? candles : []
      const bars = list.map((raw) => toBar(raw as RawCandle)).filter((bar): bar is Bar => Boolean(bar))
      if (!bars.length) return
      if (!liveRef.current) {
        liveRef.current = true
        m1Ref.current.clear()
      }
      for (const bar of bars) m1Ref.current.set(bar.time, bar)
      render()
    }

    seedDemo()
    render()
    const resize = () => chart.applyOptions(measure())
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    const reload = () => {
      void window.claudePro.botChartSnapshot?.().then((candles) => {
        paintLive(candles)
      }).catch(() => { /* snapshot ainda indisponível */ })
    }
    reload()

    const unsubHistory = window.claudePro.on('bot:candles_history', (candles: RawCandle[]) => {
      paintLive(candles)
    })
    const unsubCandle = window.claudePro.on('bot:candle', (c: RawCandle) => {
      paintLive([c])
    })
    const unsubReset = window.claudePro.on('bot:chart_reset', () => {
      seedDemo()
      render()
    })

    return () => {
      renderRef.current = () => {}
      ro.disconnect()
      unsubHistory()
      unsubCandle()
      unsubReset()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    renderRef.current()
  }, [tf])

  return (
    <div className="th-chart-stack">
      <div className="th-tfs" role="tablist" aria-label="Timeframe">
        {TIMEFRAMES.map((item) => (
          <button
            key={item}
            type="button"
            className={item === tf ? 'th-tf on' : 'th-tf'}
            onClick={() => setTf(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div className="th-chart-box">
        <div ref={containerRef} className="th-chart-box" />
        {!hasBars && <div className="th-chart-empty">{t('chart.startHint')}</div>}
      </div>
    </div>
  )
}

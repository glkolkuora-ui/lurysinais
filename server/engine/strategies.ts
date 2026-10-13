// ─── Types ────────────────────────────────────────────────────────────────────

export type Direction = 'CALL' | 'PUT'
export type StrategyName = 'ALT' | 'HARD'

export interface Candle {
  from: number   // unix seconds
  open: number
  close: number
  min: number
  max: number
}

export interface StrategyEvent {
  type: 'enter' | 'result' | 'hard_stuck_recovered'
  strategy?: StrategyName
  direction?: Direction
  isWin?: boolean
  enteredAt?: number
}

export interface StrategyConfig {
  alt: boolean
  hard: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function quadrantStart(ts: number): number {
  return Math.floor(ts / 300) * 300
}

function isBull(c: Candle): boolean { return c.close > c.open }
function isBear(c: Candle): boolean { return c.close < c.open }
function isDoji(c: Candle): boolean { return c.close === c.open }
function isValid(c: Candle): boolean { return !isDoji(c) }

function resolveWin(direction: Direction, candle: Candle): boolean {
  if (direction === 'CALL') return candle.close >= candle.open  // doji conta como win para CALL
  return candle.close < candle.open                              // doji NÃO é win para PUT
}

// ─── Strategy Engine ──────────────────────────────────────────────────────────

export class StrategyEngine {
  private candles = new Map<number, Candle>()  // keyed by candle.from (seconds)

  // Shared cooldowns
  private lastEntryTime = 0   // ms
  private seenFromAlt = new Set<number>()

  private quadrantUsed = false
  private lastQuadrantStart = -1

  // ALT
  private altCooldownUntil = 0   // ms
  private altPending: { direction: Direction; enteredAt: number } | null = null

  // HARD
  private hardTradeOpen = false
  private hardNextEntryTime = 0   // ms — próxima janela para nova entrada
  private hardLastResolution = 0  // ms
  private hardEnteredAt = 0
  private hardDirection: Direction | null = null
  private hardSeenFrom = new Set<number>()

  constructor(private config: StrategyConfig) {}

  updateConfig(config: StrategyConfig): void {
    this.config = config
  }

  // Feed a new (or updated) candle into the engine
  process(candle: Candle): StrategyEvent[] {
    const events: StrategyEvent[] = []
    const T = candle.from           // seconds
    const nowMs = Date.now()

    this.candles.set(T, candle)

    if (this.config.hard) {
      events.push(...this.processHard(T, nowMs))
    }

    const qS = quadrantStart(T)

    // Reset quadrant state on new quadrant
    if (qS !== this.lastQuadrantStart) {
      this.quadrantUsed = false
      this.lastQuadrantStart = qS
    }

    const cooldownOk = (nowMs - this.lastEntryTime) >= 55_000

    // ── Resolve pending ALT ────────────────────────────────────────────────
    if (this.altPending && T >= this.altPending.enteredAt + 60) {
      const resCandle = this.candles.get(this.altPending.enteredAt)
      if (resCandle) {
        const win = resolveWin(this.altPending.direction, resCandle)
        events.push({ type: 'result', strategy: 'ALT', direction: this.altPending.direction, isWin: win, enteredAt: this.altPending.enteredAt })
        this.altPending = null
        this.altCooldownUntil = nowMs + 90_000
      } else if (T >= this.altPending.enteredAt + 180) {
        this.altPending = null
      }
    }

    // ── ALT entry ──────────────────────────────────────────────────────────
    if (
      this.config.alt &&
      cooldownOk &&
      !this.hardTradeOpen &&
      !this.quadrantUsed &&
      !this.altPending &&
      nowMs > this.altCooldownUntil &&
      !this.seenFromAlt.has(T)
    ) {
      const c4 = this.candles.get(T - 240)
      const c3 = this.candles.get(T - 180)
      const c2 = this.candles.get(T - 120)
      const c1 = this.candles.get(T - 60)

      if (c4 && c3 && c2 && c1 && isValid(c4) && isValid(c3) && isValid(c2) && isValid(c1)) {
        const alternates =
          (isBull(c4) && isBear(c3) && isBull(c2) && isBear(c1)) ||
          (isBear(c4) && isBull(c3) && isBear(c2) && isBull(c1))

        if (alternates) {
          const direction: Direction = isBull(c1) ? 'PUT' : 'CALL'
          this.altPending = { direction, enteredAt: T }
          this.quadrantUsed = true
          this.lastEntryTime = nowMs
          this.seenFromAlt.add(T)
          events.push({ type: 'enter', strategy: 'ALT', direction, enteredAt: T })
        }
      }
    }

    return events
  }

  /** Agenda próxima entrada HARD em 25–70s (a partir de nowMs). */
  private scheduleNextHardEntry(nowMs: number): void {
    const delaySec = 25 + Math.random() * 45
    this.hardNextEntryTime = nowMs + delaySec * 1000
  }

  private processHard(T: number, nowMs: number): StrategyEvent[] {
    const events: StrategyEvent[] = []

    // Watchdog: trade stuck > 180s
    if (this.hardTradeOpen && nowMs - this.hardEnteredAt * 1000 > 180_000) {
      this.hardTradeOpen = false
      this.hardDirection = null
      this.hardEnteredAt = 0
      this.scheduleNextHardEntry(nowMs)
      events.push({ type: 'hard_stuck_recovered', strategy: 'HARD' })
    }

    if (this.hardTradeOpen) return events

    // Resolve if we have a result (60s after entry)
    if (this.hardDirection && this.hardEnteredAt > 0 && T >= this.hardEnteredAt + 60) {
      const resCandle = this.candles.get(this.hardEnteredAt)
      if (resCandle && !isDoji(resCandle)) {
        const win = resolveWin(this.hardDirection, resCandle)
        events.push({ type: 'result', strategy: 'HARD', direction: this.hardDirection, isWin: win, enteredAt: this.hardEnteredAt })
        this.hardTradeOpen = false
        this.hardDirection = null
        this.hardEnteredAt = 0
        this.scheduleNextHardEntry(nowMs)
      }
    }

    // New entry — só no início da vela: 500ms–4500ms após T (evita corrida no segundo 00)
    if (!this.hardTradeOpen && !this.altPending && nowMs >= this.hardNextEntryTime && !this.hardSeenFrom.has(T)) {
      const candleAge = nowMs - T * 1000
      if (candleAge < 500) return events
      if (candleAge >= 4500) {
        this.hardSeenFrom.add(T)
        return events
      }
      this.hardSeenFrom.add(T)
      const direction: Direction = Math.random() < 0.5 ? 'CALL' : 'PUT'
      this.hardTradeOpen = true
      this.hardDirection = direction
      this.hardEnteredAt = T
      events.push({ type: 'enter', strategy: 'HARD', direction, enteredAt: T })
    }

    return events
  }

  // Call this when a real order settles (for HARD sync)
  notifyHardOrderSettled(): void {
    this.hardTradeOpen = false
    this.hardDirection = null
    this.hardEnteredAt = 0
    this.hardLastResolution = Date.now()
    this.scheduleNextHardEntry(Date.now())
  }

  reset(): void {
    this.candles.clear()
    this.lastEntryTime = 0
    this.seenFromAlt.clear()
    this.quadrantUsed = false
    this.lastQuadrantStart = -1
    this.altCooldownUntil = 0
    this.altPending = null
    this.hardTradeOpen = false
    this.hardNextEntryTime = 0
    this.hardLastResolution = 0
    this.hardEnteredAt = 0
    this.hardDirection = null
    this.hardSeenFrom.clear()
  }
}

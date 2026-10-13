export const BANKROLL_UNLOCK = 100
export const BANKROLL_FLOOR = 20

export type BankrollReason = 'ok' | 'need_unlock' | 'need_reunlock'

export interface BankrollGateResult {
  ok: boolean
  canOperate: boolean
  unlocked: boolean
  reason: BankrollReason
  unlockAmount: number
  floorAmount: number
  error?: string
}

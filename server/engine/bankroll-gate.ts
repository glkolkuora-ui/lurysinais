import { pool } from './db'

export const BANKROLL_UNLOCK = 500
export const BANKROLL_FLOOR = 100

export type BankrollReason = 'ok' | 'need_unlock' | 'need_reunlock'

export interface BankrollGate {
  canOperate: boolean
  unlocked: boolean
  reason: BankrollReason
  unlockAmount: number
  floorAmount: number
}

function money(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

export function applyBankrollGate(amount: number, wasUnlocked: boolean): BankrollGate {
  const balance = money(amount)
  if (balance >= BANKROLL_UNLOCK) {
    return {
      canOperate: true,
      unlocked: true,
      reason: 'ok',
      unlockAmount: BANKROLL_UNLOCK,
      floorAmount: BANKROLL_FLOOR,
    }
  }
  if (wasUnlocked && balance >= BANKROLL_FLOOR) {
    return {
      canOperate: true,
      unlocked: true,
      reason: 'ok',
      unlockAmount: BANKROLL_UNLOCK,
      floorAmount: BANKROLL_FLOOR,
    }
  }
  return {
    canOperate: false,
    unlocked: false,
    reason: wasUnlocked ? 'need_reunlock' : 'need_unlock',
    unlockAmount: BANKROLL_UNLOCK,
    floorAmount: BANKROLL_FLOOR,
  }
}

const memory = new Map<string, boolean>()
let tableReady: Promise<void> | null = null

function rowKey(ownerKey: string, balanceId: string): string {
  return `${ownerKey}::${balanceId}`
}

async function ensureTable(): Promise<void> {
  if (!pool) return
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS public.bankroll_unlocks (
        owner_key text NOT NULL,
        balance_id text NOT NULL,
        unlocked boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (owner_key, balance_id)
      )
    `).then(() => undefined).catch((err: unknown) => {
      tableReady = null
      throw err
    })
  }
  await tableReady
}

async function readUnlocked(ownerKey: string, balanceId: string): Promise<boolean> {
  const key = rowKey(ownerKey, balanceId)
  if (memory.has(key)) return Boolean(memory.get(key))
  if (!pool) return false
  try {
    await ensureTable()
    const res = await pool.query<{ unlocked: boolean }>(
      `SELECT unlocked FROM public.bankroll_unlocks
       WHERE owner_key = $1 AND balance_id = $2 LIMIT 1`,
      [ownerKey, balanceId],
    )
    const unlocked = Boolean(res.rows[0]?.unlocked)
    memory.set(key, unlocked)
    return unlocked
  } catch (err) {
    console.warn('[BANKROLL] falha ao ler unlock:', (err as Error)?.message ?? err)
    return false
  }
}

async function writeUnlocked(ownerKey: string, balanceId: string, unlocked: boolean): Promise<void> {
  const key = rowKey(ownerKey, balanceId)
  memory.set(key, unlocked)
  if (!pool) return
  try {
    await ensureTable()
    if (unlocked) {
      await pool.query(
        `INSERT INTO public.bankroll_unlocks (owner_key, balance_id, unlocked, updated_at)
         VALUES ($1, $2, true, now())
         ON CONFLICT (owner_key, balance_id)
         DO UPDATE SET unlocked = true, updated_at = now()`,
        [ownerKey, balanceId],
      )
    } else {
      await pool.query(
        `DELETE FROM public.bankroll_unlocks WHERE owner_key = $1 AND balance_id = $2`,
        [ownerKey, balanceId],
      )
    }
  } catch (err) {
    console.warn('[BANKROLL] falha ao gravar unlock:', (err as Error)?.message ?? err)
  }
}

export async function evaluateBankroll(
  ownerKey: string,
  balanceId: string,
  amount: number,
): Promise<BankrollGate> {
  const owner = String(ownerKey || 'local')
  const id = String(balanceId)
  const wasUnlocked = await readUnlocked(owner, id)
  const gate = applyBankrollGate(amount, wasUnlocked)
  if (wasUnlocked !== gate.unlocked) {
    await writeUnlocked(owner, id, gate.unlocked)
  }
  return gate
}

import 'server-only'
import { getDb } from '@/lib/analytics/db'

export type BudgetAlertLevel = 50 | 80 | 100

export interface DailyBudgetRow {
  date: string
  cents_used: number
  cents_cap: number
  alert_50_sent: number
  alert_80_sent: number
  alert_100_sent: number
}

function getDailyCapCents(): number {
  const parsed = Number.parseInt(process.env.CHAT_DAILY_BUDGET_CENTS ?? '1000', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 1000
  return parsed
}

export function getBeijingDate(now = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now))
}

function getDailyBudgetRow(date: string): DailyBudgetRow {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO daily_budget
      (date, cents_used, cents_cap, alert_50_sent, alert_80_sent, alert_100_sent)
     VALUES (?, 0, ?, FALSE, FALSE, FALSE)`,
  ).run(date, getDailyCapCents())

  return db
    .prepare(
      `SELECT
        date,
        cents_used,
        cents_cap,
        alert_50_sent,
        alert_80_sent,
        alert_100_sent
      FROM daily_budget
      WHERE date = ?`,
    )
    .get(date) as DailyBudgetRow
}

export function getDailyBudget(now = Date.now()): DailyBudgetRow {
  return getDailyBudgetRow(getBeijingDate(now))
}

export function isBudgetExhausted(row: DailyBudgetRow): boolean {
  return row.cents_used >= row.cents_cap
}

export function willExceedBudget(row: DailyBudgetRow, extraCents: number): boolean {
  return row.cents_used + extraCents > row.cents_cap
}

export function consumeBudget(
  cents: number,
  now = Date.now(),
): { budget: DailyBudgetRow; triggeredAlerts: BudgetAlertLevel[] } {
  const db = getDb()
  const date = getBeijingDate(now)

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO daily_budget
        (date, cents_used, cents_cap, alert_50_sent, alert_80_sent, alert_100_sent)
       VALUES (?, 0, ?, FALSE, FALSE, FALSE)`,
    ).run(date, getDailyCapCents())

    db.prepare('UPDATE daily_budget SET cents_used = cents_used + ? WHERE date = ?').run(cents, date)

    const triggeredAlerts: BudgetAlertLevel[] = []
    const alertChecks: Array<{ level: BudgetAlertLevel; column: string }> = [
      { level: 50, column: 'alert_50_sent' },
      { level: 80, column: 'alert_80_sent' },
      { level: 100, column: 'alert_100_sent' },
    ]

    for (const item of alertChecks) {
      const changed = db
        .prepare(
          `UPDATE daily_budget
           SET ${item.column} = TRUE
           WHERE date = ?
             AND ${item.column} = FALSE
             AND cents_used * 100 >= cents_cap * ?`,
        )
        .run(date, item.level).changes
      if (changed > 0) {
        triggeredAlerts.push(item.level)
      }
    }

    const budget = getDailyBudgetRow(date)
    return { budget, triggeredAlerts }
  })

  return tx()
}

export function getDailyRemainingCents(row: DailyBudgetRow): number {
  return Math.max(0, row.cents_cap - row.cents_used)
}

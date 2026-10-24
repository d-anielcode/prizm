// Which game dates the daily results job should (re)summarize.

/** The N Eastern-time dates before `now`'s ET date, newest first (YYYY-MM-DD).
 *  Today's ET date is excluded: its games may not be finished. Re-summarizing a
 *  few days back lets a run that missed (logs not in yet, cron skipped) heal itself. */
export function recentCompletedGameDates(now: Date, days = 3): string[] {
  const todayEt = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const base = new Date(`${todayEt}T12:00:00Z`)
  const out: string[] = []
  for (let i = 1; i <= days; i++) {
    const d = new Date(base)
    d.setUTCDate(d.getUTCDate() - i)
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

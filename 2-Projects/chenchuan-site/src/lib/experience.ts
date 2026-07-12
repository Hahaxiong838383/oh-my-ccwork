const CAREER_START = {
  year: 2006,
  month: 7,
  day: 1,
}

function getShanghaiDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)

  const year = Number(parts.find((part) => part.type === 'year')?.value)
  const month = Number(parts.find((part) => part.type === 'month')?.value)
  const day = Number(parts.find((part) => part.type === 'day')?.value)

  return { year, month, day }
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function getCareerExperience(now = new Date()): {
  years: number
  months: number
  days: number
  totalMonths: number
  totalDays: number
} {
  const current = getShanghaiDateParts(now)
  const start = new Date(Date.UTC(CAREER_START.year, CAREER_START.month - 1, CAREER_START.day))
  const currentDate = new Date(Date.UTC(current.year, current.month - 1, current.day))
  const totalDays = Math.max(0, Math.floor((currentDate.getTime() - start.getTime()) / 86_400_000))

  let years = current.year - CAREER_START.year
  let months = current.month - CAREER_START.month
  let days = current.day - CAREER_START.day

  if (days < 0) {
    const previousMonth = current.month === 1 ? 12 : current.month - 1
    const previousMonthYear = current.month === 1 ? current.year - 1 : current.year
    days += getDaysInMonth(previousMonthYear, previousMonth)
    months -= 1
  }

  if (months < 0) {
    months += 12
    years -= 1
  }

  years = Math.max(0, years)
  months = totalDays === 0 ? 0 : Math.max(0, months)
  days = totalDays === 0 ? 0 : Math.max(0, days)

  return {
    years,
    months,
    days,
    totalMonths: years * 12 + months,
    totalDays,
  }
}

export function formatCareerExperience(
  now = new Date(),
  options: { spaced?: boolean; includeDays?: boolean } = {},
): string {
  const { years, months, days } = getCareerExperience(now)
  const space = options.spaced ? ' ' : ''

  if (options.includeDays) {
    return `${years}${space}年${space}${months}${space}个月${space}${days}${space}天`
  }

  if (months === 0) return `${years}${space}年`
  return `${years}${space}年${space}${months}${space}个月`
}

/** WAI's daily-metrics calendar excludes Saturdays; local dates are already normalized by the journal. */
export const isMetricsDay = (date: string): boolean => new Date(date + "T12:00:00Z").getUTCDay() !== 6;
const previousDate = (date: string): string => new Date(Date.parse(date + "T12:00:00Z") - 86400_000).toISOString().slice(0, 10);

export function previousMetricsDate(date: string): string {
  do { date = previousDate(date); } while (!isMetricsDay(date));
  return date;
}

/** A missing eligible date breaks a calm streak. Zero is an answer; another metric is not. */
export function calmStreakThrough(days: Array<{ date: string; values: Record<string, { calm?: number }> }>, person: string, through: string): number {
  const answered = new Set(days.filter(day => isMetricsDay(day.date) && day.values[person]?.calm !== undefined).map(day => day.date));
  let date = isMetricsDay(through) ? through : previousMetricsDate(through), count = 0;
  while (answered.has(date)) { count++; date = previousMetricsDate(date); }
  return count;
}

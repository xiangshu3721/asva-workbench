export const DATE_FORMAT = 'ISO-8601'

export function parseDateFromFeishu(value) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return new Date(Number(value)).toISOString()
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString()
}

export function serializeDateForFeishu(value) {
  if (value === null || value === undefined || value === '') return value
  if (typeof value === 'number') return value
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? value : parsed.getTime()
}

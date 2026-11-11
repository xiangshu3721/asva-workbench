export const DATE_FORMAT = 'ISO-8601'

export function parseDateFromFeishu(value) {
  if (value === null || value === undefined || value === '') return ''
  // Feishu record search returns date cells as a single text segment
  // (`[{ text, type }]`), while list/get may return a number or string.
  // Normalize both shapes before Date parsing; otherwise String(array)
  // becomes "[object Object]" and production event gates reject valid data.
  if (Array.isArray(value)) return value.length ? parseDateFromFeishu(value[0]) : ''
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'value')) return parseDateFromFeishu(value.value)
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return parseDateFromFeishu(value.text)
    if (Object.prototype.hasOwnProperty.call(value, 'timestamp')) return parseDateFromFeishu(value.timestamp)
  }
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

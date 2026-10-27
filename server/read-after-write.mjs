export const READ_AFTER_WRITE_DELAYS_MS = Object.freeze([0, 400, 800, 1500, 2500])
export const RECENT_WRITE_WINDOW_MS = 8_000

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

export async function boundedReadAfterWrite(read, { delays = READ_AFTER_WRITE_DELAYS_MS, isVisible = (value) => value !== null && value !== undefined } = {}) {
  let lastError
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await wait(delays[attempt])
    try {
      const value = await read(attempt)
      if (isVisible(value)) return { value, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      if (error?.retryable !== true) throw error
    }
  }
  return { value: null, attempts: delays.length, lastError }
}

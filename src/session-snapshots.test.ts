import { beforeEach, describe, expect, it } from 'vitest'
import { clearSessionSnapshots, readSessionSnapshot, writeSessionSnapshot } from './session-snapshots'

function makeStorage() {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
}

describe('session snapshots', () => {
  beforeEach(() => { Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: makeStorage() } }) })

  it('stores data with a schema and reads a fresh snapshot', () => {
    writeSessionSnapshot('asva:session:dashboard:staff-1:1', { total: 3 })
    expect(readSessionSnapshot<{ total: number }>('asva:session:dashboard:staff-1:1')).toEqual({ total: 3 })
  })

  it('expires stale snapshots and clears only ASVA session snapshots', () => {
    writeSessionSnapshot('asva:session:dashboard:staff-1:1', { total: 3 })
    const storage = window.sessionStorage as ReturnType<typeof makeStorage>
    expect(readSessionSnapshot('asva:session:dashboard:staff-1:1', -1)).toBeUndefined()
    storage.setItem('other-app:key', 'keep')
    writeSessionSnapshot('asva:session:mentor:staff-1:1', [{ id: 'mentor-1' }])
    clearSessionSnapshots()
    expect(storage.getItem('other-app:key')).toBe('keep')
    expect(storage.getItem('asva:session:mentor:staff-1:1')).toBeNull()
  })
})

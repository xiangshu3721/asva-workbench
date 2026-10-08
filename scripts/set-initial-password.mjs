import { FeishuRepository } from '../server/repository.mjs'
import { config } from '../server/config.mjs'

const phone = process.argv.find((value) => value.startsWith('--phone='))?.slice('--phone='.length) || ''
const staffId = process.argv.find((value) => value.startsWith('--staff-id='))?.slice('--staff-id='.length) || ''

if (!['true', '1'].includes(process.env.ALLOW_ADMIN_BOOTSTRAP || '') || config.dataMode !== 'production' || config.environment !== 'production') {
  throw new Error('Initial password setup disabled.')
}
if (!phone && !staffId) throw new Error('Provide --phone or --staff-id.')

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    if (!input.isTTY || typeof input.setRawMode !== 'function') return reject(new Error('Interactive TTY required.'))
    let value = ''
    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    const onData = (chunk) => {
      const char = chunk.toString()
      if (char === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return }
      if (char === '\r' || char === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); return }
      if (char === '\u007f') { value = value.slice(0, -1); return }
      if (char >= ' ') value += char
    }
    const cleanup = () => { input.setRawMode(false); input.pause(); input.off('data', onData) }
    input.on('data', onData)
  })
}

const first = await hiddenQuestion('New initial password (5-64 characters): ')
const second = await hiddenQuestion('Confirm password: ')
if (first !== second) throw new Error('Passwords do not match.')
const repository = new FeishuRepository()
const database = await repository.load()
const account = staffId ? database.staff.find((item) => item.id === staffId) : database.staff.find((item) => item.phone === phone)
if (!account) throw new Error('Staff account not found.')
await repository.setInitialPassword(account.id, first, { mustChangePassword: true })
console.log(JSON.stringify({ ok: true, staffId: account.id, phone: `${account.phone.slice(0, 3)}****${account.phone.slice(-4)}`, mustChangePassword: true }))

import fs from 'node:fs'

const file = 'release.json'
const current = JSON.parse(fs.readFileSync(file, 'utf8'))
current.releaseCounter = Number(current.releaseCounter || 0) + 1
fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
await import('./build-metadata.mjs')
console.log(`Release R${String(current.releaseCounter).padStart(3, '0')} prepared`)

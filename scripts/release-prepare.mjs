import fs from 'node:fs'

function formatRelease(counter, patch = 0) {
  const base = `R${String(counter).padStart(3, '0')}`
  return Number(patch) > 0 ? `${base}.${Number(patch)}` : base
}

const file = 'release.json'
const current = JSON.parse(fs.readFileSync(file, 'utf8'))
const patch = process.argv.includes('--patch')
if (patch) {
  current.releasePatch = Number(current.releasePatch || 0) + 1
} else {
  current.releaseCounter = Number(current.releaseCounter || 0) + 1
  current.releasePatch = 0
}
fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`)
await import('./build-metadata.mjs')
console.log(`Release ${formatRelease(current.releaseCounter, current.releasePatch)} prepared`)

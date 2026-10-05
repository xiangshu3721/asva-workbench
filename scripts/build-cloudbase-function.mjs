import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'cloudbase/functions/asva-api')
const esbuild = path.join(root, 'node_modules/.bin/esbuild')

await mkdir(outputDir, { recursive: true })
await rm(path.join(outputDir, 'index.js'), { force: true })

const args = [
  path.join(root, 'server/index.mjs'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node20',
  `--outfile=${path.join(outputDir, 'index.js')}`,
]

await new Promise((resolve, reject) => {
  const child = spawn(esbuild, args, { cwd: root, stdio: 'inherit' })
  child.on('error', reject)
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ASVA CloudBase function build failed with exit code ${code}`)))
})

await writeFile(path.join(outputDir, 'scf_bootstrap'), '#!/bin/bash\nnode index.js\n', { mode: 0o755 })

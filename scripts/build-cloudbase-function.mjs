import { mkdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputs = [
  { entry: 'server/index.mjs', dir: 'cloudbase/functions/asva-api', bootstrap: '#!/bin/bash\nnode index.js\n' },
  { entry: 'server/automatic-archive-worker.mjs', dir: 'cloudbase/functions/asva-ai-archive', bootstrap: '' },
]
const esbuild = path.join(root, 'node_modules/.bin/esbuild')

for (const output of outputs) {
  const outputDir = path.join(root, output.dir)
  await mkdir(outputDir, { recursive: true })
  await rm(path.join(outputDir, 'index.js'), { force: true })
  const args = [path.join(root, output.entry), '--bundle', '--platform=node', '--format=cjs', '--target=node20', `--outfile=${path.join(outputDir, 'index.js')}`]
  await new Promise((resolve, reject) => {
    const child = spawn(esbuild, args, { cwd: root, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ASVA CloudBase function build failed with exit code ${code}`)))
  })
  if (output.bootstrap) await writeFile(path.join(outputDir, 'scf_bootstrap'), output.bootstrap, { mode: 0o755 })
}

import fs from 'node:fs'
import path from 'node:path'
import { config } from '../server/config.mjs'
import { listFields, listRecords } from '../server/feishu.mjs'

const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const output = path.resolve(process.env.STAGE1_SNAPSHOT_FILE || path.join('stage1-backup', `stage1-final-acceptance-${timestamp}.json`))
const tableNames = ['customers', 'staff', 'products', 'enrollments', 'serviceRecords', 'profileChanges', 'appointments']

const tables = {}
const fields = {}
for (const name of tableNames) {
  const tableId = config.feishu.tables[name]
  tables[name] = tableId ? await listRecords(tableId) : []
  fields[name] = tableId ? await listFields(tableId) : []
}

const snapshot = {
  generatedAt: new Date().toISOString(),
  purpose: 'ASVA Stage 1 final acceptance pre-write snapshot',
  counts: Object.fromEntries(tableNames.map((name) => [name, tables[name].length])),
  fields: Object.fromEntries(tableNames.map((name) => [name, fields[name].map((field) => ({ field_id: field.field_id, field_name: field.field_name, type: field.type }))])),
  tables,
}
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ok: true, snapshotFile: output, counts: snapshot.counts, fileMode: '0600' }))

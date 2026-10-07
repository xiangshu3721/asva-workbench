import { config } from '../server/config.mjs'
import { listFields } from '../server/feishu.mjs'
import { contractFields, SCHEMA_GAPS } from '../server/schema-contract.mjs'

const typeNames = { 1: 'Text', 2: 'Number', 3: 'SingleSelect', 4: 'MultiSelect', 5: 'DateTime', 7: 'Checkbox', 11: 'User', 13: 'Phone', 15: 'URL', 17: 'Attachment' }
const result = { generatedAt: new Date().toISOString(), tables: {}, ok: true }

for (const [table, tableId] of Object.entries(config.feishu.tables)) {
  if (!tableId) { result.tables[table] = { skipped: true }; continue }
  const live = await listFields(tableId)
  const expected = contractFields(table)
  const liveByName = new Map(live.map((field) => [field.field_name, field]))
  const expectedByName = new Map(expected.map((field) => [field.feishu_name, field]))
  const missing = expected.filter((field) => !field.deprecated && !liveByName.has(field.feishu_name)).map((field) => field.feishu_name)
  const extra = live.filter((field) => !expectedByName.has(field.field_name)).map((field) => field.field_name)
  const deprecated = live.filter((field) => expectedByName.get(field.field_name)?.deprecated).map((field) => field.field_name)
  const typeMismatch = expected.filter((field) => liveByName.has(field.feishu_name) && typeNames[liveByName.get(field.feishu_name).type] && typeNames[liveByName.get(field.feishu_name).type] !== field.type).map((field) => ({ field: field.feishu_name, expected: field.type, actual: typeNames[liveByName.get(field.feishu_name).type] || liveByName.get(field.feishu_name).type }))
  const gaps = SCHEMA_GAPS.filter((gap) => gap.table === table && missing.includes(gap.feishu_name))
  result.tables[table] = { tableId, liveCount: live.length, missing, schemaGaps: gaps, extra, deprecated, typeMismatch }
  if (missing.some((name) => !gaps.some((gap) => gap.feishu_name === name)) || extra.length || typeMismatch.length) result.ok = false
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1

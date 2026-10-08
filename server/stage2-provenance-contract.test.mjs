import { describe, expect, it } from 'vitest'
import { fields, field } from './field-mapping.mjs'
import { contractFields } from './schema-contract.mjs'

describe('Stage 2 Provenance V2 mapping', () => {
  it('maps ProfileChanges provenance links through approved Feishu field names', () => {
    expect(field('profileChanges', 'source_record_id')).toBe('资料ID')
    expect(field('profileChanges', 'evidence_id')).toBe('证据ID')
    expect(field('profileChanges', 'update_batch_id')).toBe('更新批次ID')
    expect(fields('profileChanges', { source_record_id: 'SRC-1', evidence_id: 'EVD-1', update_batch_id: 'EXT-1' })).toEqual({ 资料ID: 'SRC-1', 证据ID: 'EVD-1', 更新批次ID: 'EXT-1' })
  })

  it('keeps the three Provenance V2 fields in the schema contract', () => {
    const keys = new Set(contractFields('profileChanges').map((item) => item.internal_key))
    expect([...keys]).toEqual(expect.arrayContaining(['source_record_id', 'evidence_id', 'update_batch_id']))
  })
})

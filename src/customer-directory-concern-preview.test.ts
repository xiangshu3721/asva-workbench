import { describe, expect, it } from 'vitest'
import type { Customer } from './domain'
import { customerDirectoryConcernPreview } from './customer-directory-concern-preview'

const customer = (values: Partial<Customer> = {}) => ({
  id: 'CUS-DIR-1', need: '', notes: '', profileFields: {}, profileFieldMeta: {},
  ...values,
} as Customer)

describe('directory concern preview remains conservative', () => {
  it('does not claim that no current concern exists when the directory need field is empty', () => {
    const output = customerDirectoryConcernPreview(customer())
    expect(output).toBe('查看详情中的咨询线索')
    expect(output).not.toContain('尚未记录当前困扰')
  })

  it('shows the existence of a current concern from notes without leaking private note excerpts', () => {
    const output = customerDirectoryConcernPreview(customer({ notes: '经济压力，另外涉及个人隐私信息' }))
    expect(output).toBe('已记录困扰线索 · 查看详情')
    expect(output).not.toContain('个人隐私')
    expect(output).not.toContain('经济压力')
  })

  it('uses a broad direction for a documented consultation intent, not an invented problem', () => {
    const output = customerDirectoryConcernPreview(customer({ notes: '更多咨询情感问题，有一个男朋友' }))
    expect(output).toBe('咨询方向：亲密关系 · 待确认')
    expect(output).not.toContain('冲突')
  })

  it('preserves the existing current need field without promoting it to a verified claim', () => {
    const output = customerDirectoryConcernPreview(customer({ need: '经济压力' }))
    expect(output).toBe('经济压力')
  })

  it('only preserves need text when the same current consultation signal supports it', () => {
    expect(customerDirectoryConcernPreview(customer({ need: '过去工作压力很大，现在已经解决。' }))).toBe('查看详情中的咨询线索')
    expect(customerDirectoryConcernPreview(customer({
      need: 'AI 总结：客户有关系焦虑',
      profileFieldMeta: { current_core_issue: { source: 'AI_INFERENCE', confidence: 0.7, confirmed: false, updatedAt: '2026-11-16' } },
    }))).toBe('查看详情中的咨询线索')
  })

  it('does not display resolved history or AI speculation as a new current concern', () => {
    const resolved = customerDirectoryConcernPreview(customer({ notes: '过去工作压力很大，现在已经解决。' }))
    const conjecture = customerDirectoryConcernPreview(customer({ notes: 'AI 总结：有亲密关系问题' }))
    expect(resolved).toBe('查看详情中的咨询线索')
    expect(conjecture).toBe('查看详情中的咨询线索')
  })

  it('caps long legacy need text for the narrow customer list', () => {
    const output = customerDirectoryConcernPreview(customer({ need: '经济压力'.repeat(30) }))
    expect(output.length).toBeLessThanOrEqual(56)
  })
})

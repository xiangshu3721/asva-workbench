import { describe, expect, it } from 'vitest'
import { readFeishuRichText } from './repository.mjs'

describe('Feishu rich text decoding', () => {
  it('reads plain values, single text nodes, contiguous segments, nested nodes and empty values', () => {
    expect(readFeishuRichText('普通字符串')).toBe('普通字符串')
    expect(readFeishuRichText(28)).toBe('28')
    expect(readFeishuRichText([{ type: 'text', text: '单段文本' }])).toBe('单段文本')
    expect(readFeishuRichText([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }])).toBe('第一段第二段')
    expect(readFeishuRichText({ children: [{ text: '嵌套' }, { text: '节点' }] })).toBe('嵌套节点')
    expect(readFeishuRichText(null)).toBe('')
    expect(readFeishuRichText([{ type: 'url', link: 'https://example.com' }])).toBe('')
  })

  it('preserves JSON metadata when Feishu splits a quoted Chinese payload', () => {
    const metadata = JSON.stringify({ _automatic_profile_pending: { contentHash: 'abc', actorId: 'ADMIN-1', reason: 'CUSTOMER_SAVE' }, note: '含中文“引号”与\\n转义' })
    const split = [metadata.slice(0, 13), metadata.slice(13, 29), metadata.slice(29)].map((text) => ({ type: 'text', text }))
    const decoded = readFeishuRichText(split)
    expect(() => JSON.parse(decoded)).not.toThrow()
    expect(JSON.parse(decoded)).toMatchObject({ _automatic_profile_pending: { reason: 'CUSTOMER_SAVE', actorId: 'ADMIN-1' } })
  })
})

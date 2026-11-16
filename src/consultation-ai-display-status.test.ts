import { describe, expect, it } from 'vitest'
import { consultationAiDisplayStatus } from './consultation-ai-display-status'

describe('consultation AI status copy', () => {
  it('keeps failed deeper understanding separate from usable consultation signals', () => {
    const result = consultationAiDisplayStatus('FAILED', '', true)
    expect(result.label).toBe('AI 理解未完成')
    expect(result.notice).toContain('AI 深度理解未完成')
    expect(result.notice).toContain('咨询线索仍可供初步核实')
    expect(result.notice).not.toContain('上一次可用结果')
  })

  it('does not say there are usable concerns when no current signals exist', () => {
    const result = consultationAiDisplayStatus('FAILED', '', false)
    expect(result.notice).toContain('先根据已有资料了解客户需要')
    expect(result.notice).not.toContain('咨询线索仍可供初步核实')
  })

  it('labels AI being updated without labeling the entire consultation panel as unusable', () => {
    const result = consultationAiDisplayStatus('PROCESSING', '', true)
    expect(result.label).toBe('AI 理解整理中')
    expect(result.notice).toContain('当前咨询线索仍可供初步核实')
  })

  it('separates refresh failure and read failure without saying both views failed', () => {
    expect(consultationAiDisplayStatus('STALE', '重新整理失败：超时', true).notice).toContain('更新未完成')
    expect(consultationAiDisplayStatus('STALE', '读取咨询理解失败：网络超时', true).notice).toContain('读取失败')
  })

  it('does not label the previous AI version as freshly updated when a new refresh or read failed', () => {
    const update = consultationAiDisplayStatus('FRESH', '重新整理失败：网络超时', true)
    expect(update.label).toBe('AI 更新未完成')
    expect(update.notice).toContain('更新未完成')
    const read = consultationAiDisplayStatus('FRESH', '读取咨询理解失败：网络中断', true)
    expect(read.label).toBe('AI 读取未完成')
    expect(read.notice).toContain('读取失败')
  })

  it('does not show a redundant warning for a fresh or merely stale AI understanding', () => {
    expect(consultationAiDisplayStatus('FRESH', '', true)).toEqual({ label: 'AI 理解已整理', notice: '' })
    expect(consultationAiDisplayStatus('STALE', '', true)).toEqual({ label: 'AI 理解待更新', notice: '' })
  })
})

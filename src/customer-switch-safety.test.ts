import { describe, expect, it } from 'vitest'
import { canCommitCustomerResponse, createCustomerScopedState, isCustomerScopedStateFor } from './customer-switch-safety'

describe('customer switch AI state safety', () => {
  it('clears the visible state identity immediately when the selected customer changes', () => {
    const state = createCustomerScopedState('CUS-A', { text: '阿文的理解' })
    expect(isCustomerScopedStateFor(state, 'CUS-A')).toBe(true)
    expect(isCustomerScopedStateFor(state, 'CUS-B')).toBe(false)
  })

  it('ignores a late response from the previous customer', () => {
    expect(canCommitCustomerResponse({
      requestCustomerId: 'CUS-A',
      activeCustomerId: 'CUS-B',
      requestSequence: 1,
      activeSequence: 2,
      responseCustomerId: 'CUS-A',
    })).toBe(false)
  })

  it('ignores an out-of-order response even when the customer is unchanged', () => {
    expect(canCommitCustomerResponse({
      requestCustomerId: 'CUS-A',
      activeCustomerId: 'CUS-A',
      requestSequence: 1,
      activeSequence: 2,
      responseCustomerId: 'CUS-A',
    })).toBe(false)
  })

  it('accepts only the current customer response with the current sequence', () => {
    expect(canCommitCustomerResponse({
      requestCustomerId: 'CUS-B',
      activeCustomerId: 'CUS-B',
      requestSequence: 3,
      activeSequence: 3,
      responseCustomerId: 'CUS-B',
    })).toBe(true)
  })

  it('rejects a response whose payload customer id does not match the request', () => {
    expect(canCommitCustomerResponse({
      requestCustomerId: 'CUS-B',
      activeCustomerId: 'CUS-B',
      requestSequence: 3,
      activeSequence: 3,
      responseCustomerId: 'CUS-A',
    })).toBe(false)
  })

  it('keeps the newly selected customer in an explicit loading state instead of showing the previous value', () => {
    const states = {
      'CUS-A': createCustomerScopedState('CUS-A', { text: '阿文销售分析' }),
      'CUS-B': createCustomerScopedState('CUS-B', null, true),
    }
    expect(states['CUS-B'].value).toBeNull()
    expect(states['CUS-B'].loading).toBe(true)
    expect(states['CUS-A'].value).not.toBe(states['CUS-B'].value)
  })

  it('can retain independent sales states while switching back and forth', () => {
    const states = {
      'CUS-A': createCustomerScopedState('CUS-A', { text: '阿文销售分析' }),
      'CUS-B': createCustomerScopedState('CUS-B', { text: '丽丽销售分析' }),
      'CUS-C': createCustomerScopedState('CUS-C', { text: '小岚销售分析' }),
    }
    expect(states['CUS-A'].value?.text).toBe('阿文销售分析')
    expect(states['CUS-B'].value?.text).toBe('丽丽销售分析')
    expect(states['CUS-C'].value?.text).toBe('小岚销售分析')
  })

  it('requires the selected customer id for both consultation and sales payloads', () => {
    const request = { requestCustomerId: 'CUS-B', activeCustomerId: 'CUS-B', requestSequence: 4, activeSequence: 4 }
    expect(canCommitCustomerResponse({ ...request, responseCustomerId: 'CUS-B' })).toBe(true)
    expect(canCommitCustomerResponse({ ...request, responseCustomerId: 'CUS-A' })).toBe(false)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeCustomerDto } from './clientApi'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('R043 progressive customer rendering', () => {
  it('renders the customer shell while the directory request is pending', () => {
    expect(appSource).toContain('directoryLoading={!database}')
    expect(appSource).toContain('customer-list-loading')
    expect(appSource).not.toContain('const customerPage = database ?')
  })

  it('defers AI, safety, and evidence reads until the user asks for them', () => {
    expect(appSource).toContain('onViewChange={changeUnderstandingView}')
    expect(appSource).toContain('const loadUnderstanding = async () =>')
    expect(appSource).toContain('const loadSalesUnderstanding = async () =>')
    expect(appSource).toContain('const load = async () =>')
    expect(appSource).toContain('onToggle={(event) => setEvidenceOpen(event.currentTarget.open)}')
    expect(appSource).toContain('{evidenceOpen ? <EvidenceWorkspace')
    expect(appSource).not.toContain('if (understandingByCustomerId[requestCustomerId]) return\n    const requestSequence')
  })

  it('does not fall back to a previous customer during a routed switch', () => {
    expect(appSource).toContain('const selectedCustomer = selectedCustomerId ? database?.customers.find((item) => item.id === selectedCustomerId) : database?.customers[0]')
  })

  it('normalizes a coverage-only directory customer without treating the profile as loaded', () => {
    const customer = normalizeCustomerDto({ id: 'CUS-1', name: 'Synthetic 客户', profileMaterialization: { coverage: { percentage: 27, domains: [] } } })
    expect(customer.confirmedFacts).toEqual([])
    expect(customer.aiQuestions).toEqual([])
    expect(customer.profileMaterialization?.lifeEvents).toEqual([])
    expect(customer.profileMaterializationLoaded).toBe(false)
  })

  it('keeps full materialization loaded when the detail DTO includes its collections', () => {
    const customer = normalizeCustomerDto({ id: 'CUS-1', name: 'Synthetic 客户', profileMaterialization: { sections: [], lifeEvents: [], coverage: { percentage: 100, domains: [] } } })
    expect(customer.profileMaterializationLoaded).toBe(true)
  })

  it('guards the renderer against an incomplete progressive materialization', () => {
    expect(appSource).toContain('const lifeEvents = materialization?.lifeEvents || []')
    expect(appSource).toContain('customer.profileMaterializationLoaded !== false')
  })
})

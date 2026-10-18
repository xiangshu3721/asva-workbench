const sizes = [50, 200, 1000]
const iterations = 25

function makeFixture(customerCount) {
  const customers = Array.from({ length: customerCount }, (_, index) => ({ id: `CUS-${index + 1}` }))
  const evidenceItems = Array.from({ length: customerCount * 8 }, (_, index) => ({
    id: `EVD-${index + 1}`,
    customerId: customers[index % customerCount].id,
    displayText: `证据 ${index + 1}`,
  }))
  const fullTables = {
    appointments: Array.from({ length: customerCount * 2 }, (_, index) => ({ id: `APT-${index + 1}` })),
    customers,
    serviceRecords: Array.from({ length: customerCount * 2 }, (_, index) => ({ id: `SRV-${index + 1}` })),
    staff: Array.from({ length: 20 }, (_, index) => ({ id: `STAFF-${index + 1}` })),
    products: Array.from({ length: 13 }, (_, index) => ({ id: `P-${index + 1}` })),
    enrollments: Array.from({ length: customerCount }, (_, index) => ({ id: `ENR-${index + 1}` })),
    profileChanges: Array.from({ length: customerCount * 2 }, (_, index) => ({ id: `CHANGE-${index + 1}` })),
    sourceRecords: Array.from({ length: customerCount * 3 }, (_, index) => ({ id: `SRC-${index + 1}` })),
    evidenceItems,
    profileUpdateProposals: Array.from({ length: customerCount }, (_, index) => ({ id: `PROP-${index + 1}` })),
    evidenceConflicts: [],
  }
  return { customers, evidenceItems, fullTables }
}

function legacyProjection({ customers, evidenceItems }) {
  return customers.map((customer) => ({ ...customer, evidence: evidenceItems.filter((item) => item.customerId === customer.id) }))
}

function optimizedProjection({ customers, evidenceItems }) {
  const grouped = new Map()
  for (const item of evidenceItems) {
    const list = grouped.get(item.customerId) || []
    list.push(item)
    grouped.set(item.customerId, list)
  }
  return customers.map((customer) => ({ ...customer, evidence: grouped.get(customer.id) || [] }))
}

function payloadBytes(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

function measure(fn) {
  const samples = []
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now()
    fn()
    samples.push(performance.now() - startedAt)
  }
  samples.sort((a, b) => a - b)
  return { p50_ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(3)), p95_ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)) }
}

console.log(JSON.stringify({ benchmark: 'R042 synthetic local fixture; no Production data or network calls', iterations, results: sizes.map((customerCount) => {
  const fixture = makeFixture(customerCount)
  const legacy = measure(() => legacyProjection(fixture))
  const optimized = measure(() => optimizedProjection(fixture))
  const directoryPayload = { customers: fixture.customers, staff: fixture.fullTables.staff, products: fixture.fullTables.products, enrollments: fixture.fullTables.enrollments.map((item) => item.id), evidenceCoverage: fixture.customers.map((item) => item.id) }
  return {
    customers: customerCount,
    evidence: fixture.evidenceItems.length,
    legacy_projection: legacy,
    optimized_projection: optimized,
    projection_speedup_p50: Number((legacy.p50_ms / Math.max(optimized.p50_ms, 0.001)).toFixed(2)),
    full_payload_bytes: payloadBytes(fixture.fullTables),
    directory_payload_bytes: payloadBytes(directoryPayload),
    directory_payload_reduction_percent: Number((100 * (1 - payloadBytes(directoryPayload) / payloadBytes(fixture.fullTables))).toFixed(2)),
    directory_table_reads: 5,
    full_dashboard_table_reads: 11,
    customer_detail_table_reads: 7,
  }
}) }, null, 2))

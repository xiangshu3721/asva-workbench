const stripSeparators = (value) => String(value || '').trim().replace(/[\s().-]/g, '')

export function normalizePhone(value) {
  const raw = stripSeparators(value)
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (/^(?:\+?86)1\d{10}$/.test(raw)) return digits.slice(-11)
  if (!raw.startsWith('+') && /^1\d{10}$/.test(digits)) return digits
  if (raw.startsWith('+')) return `+${digits}`
  return digits
}

export function normalizeWechat(value) {
  return String(value || '').trim().toLowerCase()
}

export function normalizeNickname(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function contactRequired({ phone, wechat }) {
  return Boolean(normalizePhone(phone) || normalizeWechat(wechat))
}

export function validateCustomerContactField(field, value) {
  const rawValue = String(value || '').trim()
  if (!rawValue) return { ok: true, field, message: '' }
  if (field === 'phone') {
    return /^1[3-9]\d{9}$/.test(normalizePhone(rawValue))
      ? { ok: true, field, message: '' }
      : { ok: false, field, message: '请输入有效的11位大陆手机号。' }
  }
  if (field === 'wechat') {
    return /^[A-Za-z][A-Za-z0-9_-]{5,19}$/.test(rawValue)
      ? { ok: true, field, message: '' }
      : { ok: false, field, message: '微信号需为6～20位、字母开头，可包含字母、数字、下划线或减号。' }
  }
  return { ok: false, field, message: '联系方式字段无效。' }
}

export function validateCustomerContacts({ phone, wechat } = {}) {
  const rawPhone = String(phone || '').trim()
  const rawWechat = String(wechat || '').trim()
  const normalizedPhone = normalizePhone(rawPhone)
  const phoneValidation = validateCustomerContactField('phone', rawPhone)
  if (!phoneValidation.ok) return { ...phoneValidation, phone: normalizedPhone, wechat: rawWechat }
  const wechatValidation = validateCustomerContactField('wechat', rawWechat)
  if (!wechatValidation.ok) return { ...wechatValidation, phone: normalizedPhone, wechat: rawWechat }
  if (!rawPhone && !rawWechat) {
    return { ok: false, field: 'contact', message: '手机号或微信号至少填写一个联系方式。', phone: '', wechat: '' }
  }
  return { ok: true, field: '', message: '', phone: normalizedPhone, wechat: rawWechat }
}

function candidateMatches(customers, field, value, normalizer) {
  if (!value) return []
  return customers.filter((customer) => normalizer(customer[field]) === value)
}

export function resolveCustomerIdentity(customers, input) {
  const customerId = String(input?.customerId || '').trim()
  const phone = normalizePhone(input?.phone)
  const wechat = normalizeWechat(input?.wechat)
  const nickname = normalizeNickname(input?.nickname)
  if (customerId) {
    const exact = customers.filter((customer) => String(customer.id) === customerId)
    if (exact.length === 1) return { result: 'EXACT_MATCH', matched_customer_id: exact[0].id, match_reasons: ['CUSTOMER_ID_EXACT'], confidence: 1, matches: exact }
  }
  const phoneMatches = candidateMatches(customers, 'phone', phone, normalizePhone)
  const wechatMatches = candidateMatches(customers, 'wechat', wechat, normalizeWechat)
  const phoneIds = new Set(phoneMatches.map((customer) => customer.id))
  const wechatIds = new Set(wechatMatches.map((customer) => customer.id))
  if (phoneMatches.length && wechatMatches.length) {
    const intersection = phoneMatches.filter((customer) => wechatIds.has(customer.id))
    if (intersection.length === 1) return { result: 'EXACT_MATCH', matched_customer_id: intersection[0].id, match_reasons: ['PHONE_EXACT', 'WECHAT_EXACT'], confidence: 1, matches: intersection }
    return { result: 'CONFLICT', matched_customer_id: null, match_reasons: ['PHONE_WECHAT_CONFLICT'], confidence: 1, matches: [...new Map([...phoneMatches, ...wechatMatches].map((customer) => [customer.id, customer])).values()] }
  }
  if (phoneMatches.length === 1) return { result: 'EXACT_MATCH', matched_customer_id: phoneMatches[0].id, match_reasons: ['PHONE_EXACT'], confidence: 1, matches: phoneMatches }
  if (wechatMatches.length === 1) return { result: 'EXACT_MATCH', matched_customer_id: wechatMatches[0].id, match_reasons: ['WECHAT_EXACT'], confidence: 1, matches: wechatMatches }
  if (phoneMatches.length > 1 || wechatMatches.length > 1) return { result: 'CONFLICT', matched_customer_id: null, match_reasons: ['DUPLICATE_CONTACT'], confidence: 1, matches: [...new Map([...phoneMatches, ...wechatMatches].map((customer) => [customer.id, customer])).values()] }
  if (nickname) {
    const possible = customers.filter((customer) => normalizeNickname(customer.name) === nickname)
    if (possible.length) return { result: 'POSSIBLE_MATCH', matched_customer_id: null, match_reasons: ['NICKNAME_EXACT'], confidence: 0.5, matches: possible }
  }
  return { result: 'NEW_CUSTOMER', matched_customer_id: null, match_reasons: [], confidence: 0, matches: [] }
}

export function provenance(source, confirmed = false) {
  if (confirmed && source === 'AI_INFERENCE') return 'AI_EXTRACTED_CONFIRMED'
  if (confirmed && source === 'MENTOR_OBSERVATION') return 'MENTOR_FACTUAL_INPUT'
  if (confirmed && source === 'USER_EXPLICIT') return 'ADMIN_CONFIRMED'
  return source || 'STRUCTURED_INPUT'
}

const WEAK_PASSWORDS = new Set(['12345', '123456', '1234567890', '12345678901', '88888', '888888', '8888888888', 'abcde', 'abcdefghij', 'qwerty', 'qwertyuiop', 'admin', 'password', 'password123', '1111111111', '0000000000'])

export const PASSWORD_POLICY_CODES = Object.freeze({
  REQUIRED: 'PASSWORD_REQUIRED',
  LENGTH_INVALID: 'PASSWORD_LENGTH_INVALID',
  TOO_WEAK: 'PASSWORD_TOO_WEAK',
  SIMILAR_TO_PHONE: 'PASSWORD_SIMILAR_TO_PHONE',
  SAME_AS_TEMPORARY: 'PASSWORD_SAME_AS_TEMPORARY',
  CONFIRM_MISMATCH: 'PASSWORD_CONFIRM_MISMATCH',
})

export const PASSWORD_POLICY_MESSAGES = Object.freeze({
  [PASSWORD_POLICY_CODES.REQUIRED]: '请输入新密码',
  [PASSWORD_POLICY_CODES.LENGTH_INVALID]: '密码需为5～64位',
  [PASSWORD_POLICY_CODES.TOO_WEAK]: '这个密码过于简单，请换一个更难猜的密码',
  [PASSWORD_POLICY_CODES.SIMILAR_TO_PHONE]: '密码不能与手机号相同或过于相似',
  [PASSWORD_POLICY_CODES.SAME_AS_TEMPORARY]: '新密码不能与初始密码相同',
  [PASSWORD_POLICY_CODES.CONFIRM_MISMATCH]: '两次输入的密码不一致',
})

export class PasswordPolicyError extends Error {
  constructor(code) {
    super(PASSWORD_POLICY_MESSAGES[code] || '密码不符合要求')
    this.name = 'PasswordPolicyError'
    this.code = code
    this.status = 400
  }
}

const text = (value) => typeof value === 'string' ? value : ''
const normalizePhone = (value) => text(value).replace(/[\s-]/g, '')

export function passwordPolicyMessage(code) {
  return PASSWORD_POLICY_MESSAGES[code] || ''
}

export function validatePassword(password, { phone = '' } = {}) {
  const value = text(password)
  if (!value) throw new PasswordPolicyError(PASSWORD_POLICY_CODES.REQUIRED)
  if (value.length < 5 || value.length > 64) throw new PasswordPolicyError(PASSWORD_POLICY_CODES.LENGTH_INVALID)
  const normalizedPhone = normalizePhone(phone)
  const normalizedPassword = value.toLowerCase()
  const passwordDigits = value.replace(/\D/g, '')
  const phoneDistance = normalizedPhone && passwordDigits.length >= 8 ? levenshteinDistance(passwordDigits, normalizedPhone) : Number.POSITIVE_INFINITY
  const phoneLike = Boolean(normalizedPhone && passwordDigits.length >= 5 && (normalizedPhone.includes(passwordDigits) || passwordDigits.includes(normalizedPhone) || phoneDistance <= 1))
  if (phoneLike) throw new PasswordPolicyError(PASSWORD_POLICY_CODES.SIMILAR_TO_PHONE)
  if (/^(.)(\1)+$/.test(value) || WEAK_PASSWORDS.has(normalizedPassword)) throw new PasswordPolicyError(PASSWORD_POLICY_CODES.TOO_WEAK)
  return true
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[right.length]
}

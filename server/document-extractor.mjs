import crypto from 'node:crypto'
import zlib from 'node:zlib'

const DEFAULT_MAX_DOCUMENT_SIZE_MB = 20
export const DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.docx'])
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown'])
const MIME_BY_EXTENSION = {
  '.txt': new Set(['text/plain', 'application/octet-stream']),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.markdown': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream']),
}

export class DocumentExtractionError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'DocumentExtractionError'
    this.code = code
    Object.assign(this, details)
  }
}

export const unsupportedDocumentMessage = '当前支持 TXT、Markdown 和 Word（.docx）文件。'

function extensionOf(value) {
  const match = String(value || '').toLowerCase().match(/\.[a-z0-9]+$/)
  return match ? match[0] : ''
}

function mimeOf(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase() }

export function normalizeDocumentText(value) {
  return String(value || '').replace(/^\uFEFF/, '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n').replace(/^\n+|\n+$/g, '')
}

function decoder(label, buffer) {
  try { return new TextDecoder(label, { fatal: true }).decode(buffer) } catch { return '' }
}

export function decodeTextBuffer(buffer) {
  const utf8 = decoder('utf-8', buffer)
  if (utf8) return normalizeDocumentText(utf8)
  for (const label of ['gb18030', 'big5', 'windows-1252']) {
    const decoded = decoder(label, buffer)
    if (decoded) return normalizeDocumentText(decoded)
  }
  return normalizeDocumentText(new TextDecoder('utf-8').decode(buffer))
}

function assertSize(buffer, maxDocumentSizeMb) {
  const limit = (Number(maxDocumentSizeMb) || DEFAULT_MAX_DOCUMENT_SIZE_MB) * 1024 * 1024
  if (buffer.length > limit) throw new DocumentExtractionError('文件较大，请压缩后再上传。', 'DOCUMENT_TOO_LARGE', { size: buffer.length, limit })
}

function validateSignature(buffer, extension) {
  if (extension === '.docx' && buffer.subarray(0, 2).toString('ascii') !== 'PK') throw new DocumentExtractionError('DOCX 文件损坏或无法读取。', 'DOCX_CORRUPT')
}

export function validateDocumentInput({ filename, mimeType, extension, buffer, maxDocumentSizeMb } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new DocumentExtractionError('文件内容无效。', 'INVALID_DOCUMENT')
  const normalizedExtension = String(extension || extensionOf(filename)).toLowerCase()
  const normalizedMime = mimeOf(mimeType)
  if (!DOCUMENT_EXTENSIONS.has(normalizedExtension)) throw new DocumentExtractionError(unsupportedDocumentMessage, 'UNSUPPORTED_DOCUMENT_FORMAT')
  if (normalizedMime && !MIME_BY_EXTENSION[normalizedExtension].has(normalizedMime)) throw new DocumentExtractionError(unsupportedDocumentMessage, 'INVALID_DOCUMENT_MIME')
  assertSize(buffer, maxDocumentSizeMb)
  validateSignature(buffer, normalizedExtension)
  return { extension: normalizedExtension, mimeType: normalizedMime, size: buffer.length }
}

function xmlDecode(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function unzipEntries(buffer) {
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) break
    const flags = buffer.readUInt16LE(offset + 6)
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    if (flags & 0x08) throw new DocumentExtractionError('DOCX 文件损坏或无法读取。', 'DOCX_CORRUPT')
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    const compressed = buffer.subarray(start, start + compressedSize)
    let content
    try { content = method === 0 ? compressed : method === 8 ? zlib.inflateRawSync(compressed) : null } catch { content = null }
    if (!content) throw new DocumentExtractionError('DOCX 文件损坏或无法读取。', 'DOCX_CORRUPT')
    entries.set(name, content)
    offset = start + compressedSize
  }
  return entries
}

function extractDocx(buffer) {
  const xmlBuffer = unzipEntries(buffer).get('word/document.xml')
  if (!xmlBuffer) throw new DocumentExtractionError('DOCX 文件损坏或无法读取。', 'DOCX_CORRUPT')
  const xml = xmlBuffer.toString('utf8')
  const blocks = []
  const tableToken = (block) => {
    const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) => [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => [...cell[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => xmlDecode(part[1])).join('')).filter(Boolean).join(' | ')).filter(Boolean)
    return rows.length ? `<asva-table>${rows.join('\n')}</asva-table>` : ''
  }
  const xmlWithTableTokens = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (block) => tableToken(block))
  for (const match of xmlWithTableTokens.matchAll(/<asva-table>([\s\S]*?)<\/asva-table>|(<w:p\b[\s\S]*?<\/w:p>)/g)) {
    if (match[1]) { blocks.push(match[1]); continue }
    const block = match[2]
    const text = [...block.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) => xmlDecode(part[1])).join('')
    if (text.trim()) blocks.push(/<w:numPr\b/.test(block) ? `- ${text}` : text)
  }
  return normalizeDocumentText(blocks.join('\n\n'))
}

export async function extractDocument({ filename, mimeType, extension, buffer, maxDocumentSizeMb } = {}) {
  const startedAt = Date.now()
  const validated = validateDocumentInput({ filename, mimeType, extension, buffer, maxDocumentSizeMb })
  const extractedText = TEXT_EXTENSIONS.has(validated.extension) ? decodeTextBuffer(buffer) : extractDocx(buffer)
  const normalized = normalizeDocumentText(extractedText)
  return { document_type: validated.extension.slice(1).toUpperCase(), extracted_text: normalized, extraction_method: validated.extension === '.txt' ? 'TEXT' : validated.extension === '.docx' ? 'DOCX_XML' : 'MARKDOWN', char_count: Array.from(normalized).length, warnings: [], duration_ms: Date.now() - startedAt, file_hash: crypto.createHash('sha256').update(buffer).digest('hex'), size: buffer.length }
}

export function documentFileRef({ filename, mimeType, extension, size, fileHash, charCount }) {
  return JSON.stringify({ version: 1, storage: 'TEMPORARY', original_filename: String(filename || '').slice(0, 200), file_type: String(extension || extensionOf(filename)).toLowerCase(), mime_type: mimeOf(mimeType), file_hash: String(fileHash || ''), char_count: Number(charCount) || 0, size: Number(size) || 0 })
}

export function parseDocumentFileRef(value) {
  try {
    const parsed = JSON.parse(String(value || ''))
    if (parsed?.version === 1 && parsed.original_filename && parsed.file_hash) return parsed
  } catch {}
  return null
}

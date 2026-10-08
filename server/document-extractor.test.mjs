import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { describe, it } from 'vitest'
import { DocumentExtractionError, documentFileRef, extractDocument, parseDocumentFileRef, unsupportedDocumentMessage } from './document-extractor.mjs'

function zipEntry(name, content) {
  const nameBuffer = Buffer.from(name)
  const compressed = zlib.deflateRawSync(Buffer.from(content))
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(8, 8)
  header.writeUInt32LE(compressed.length, 18)
  header.writeUInt32LE(Buffer.byteLength(content), 22)
  header.writeUInt16LE(nameBuffer.length, 26)
  return Buffer.concat([header, nameBuffer, compressed])
}

describe('DocumentExtractor V1', () => {
  it('normalizes UTF-8 text and keeps paragraph structure', async () => {
    const result = await extractDocument({ filename: '资料.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFF第一段\r\n\r\n第二段\u0000') })
    assert.equal(result.document_type, 'TXT')
    assert.equal(result.extraction_method, 'TEXT')
    assert.equal(result.extracted_text, '第一段\n\n第二段')
  })

  it('keeps markdown headings, lists, quotes and code blocks', async () => {
    const result = await extractDocument({ filename: '资料.markdown', mimeType: 'text/markdown', buffer: Buffer.from('# 标题\n\n- 一项\n\n> 引用\n\n```js\nconst ok = true\n```') })
    assert.equal(result.document_type, 'MARKDOWN')
    assert.match(result.extracted_text, /# 标题\n\n- 一项/)
    assert.match(result.extracted_text, /> 引用/)
    assert.match(result.extracted_text, /const ok = true/)
  })

  it('extracts DOCX paragraphs, list items and table cells', async () => {
    const xml = '<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p><w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>列表项</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>客户</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'
    const result = await extractDocument({ filename: '资料.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: zipEntry('word/document.xml', xml) })
    assert.equal(result.document_type, 'DOCX')
    assert.match(result.extracted_text, /标题/)
    assert.match(result.extracted_text, /- 列表项/)
    assert.match(result.extracted_text, /姓名 \| 客户/)
  })

  it('rejects PDF, DOC, images and corrupt DOCX with one user-facing message', async () => {
    for (const [filename, mimeType, buffer] of [['资料.pdf', 'application/pdf', Buffer.from('%PDF-1.4')], ['资料.doc', 'application/msword', Buffer.from([0xD0, 0xCF, 0x11, 0xE0])], ['资料.png', 'image/png', Buffer.from([0x89, 0x50, 0x4E, 0x47])]]) {
      await assert.rejects(() => extractDocument({ filename, mimeType, buffer }), (error) => error instanceof DocumentExtractionError && error.code === 'UNSUPPORTED_DOCUMENT_FORMAT' && error.message === unsupportedDocumentMessage)
    }
    await assert.rejects(() => extractDocument({ filename: '坏.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('not-a-zip') }), (error) => error.code === 'DOCX_CORRUPT' || error.code === 'INVALID_DOCUMENT_SIGNATURE')
  })

  it('handles empty and oversized files explicitly', async () => {
    const empty = await extractDocument({ filename: '空.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) })
    assert.equal(empty.char_count, 0)
    await assert.rejects(() => extractDocument({ filename: '大.txt', mimeType: 'text/plain', buffer: Buffer.alloc(21), maxDocumentSizeMb: 0.00001 }), (error) => error.code === 'DOCUMENT_TOO_LARGE' && error.message === '文件较大，请压缩后再上传。')
  })

  it('stores only temporary file metadata and hashes', () => {
    const fileHash = crypto.createHash('sha256').update('file').digest('hex')
    const ref = documentFileRef({ filename: '资料.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx', size: 10, fileHash, charCount: 42 })
    assert.equal(parseDocumentFileRef(ref)?.storage, 'TEMPORARY')
    assert.equal(parseDocumentFileRef(ref)?.char_count, 42)
    assert.equal(parseDocumentFileRef(ref)?.file_hash, fileHash)
  })
})

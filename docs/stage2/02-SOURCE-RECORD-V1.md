# SourceRecord V1

逻辑实体 `SourceRecord`，对应 Feishu 表 `ASVA 客户原始资料`。原始文本是不可悄悄覆盖的依据；文本修正使用新版本而非覆盖旧资料。

## 核心字段

`source_id`, `subject_type`, `subject_id`, `customer_id`, `source_type`, `title`, `raw_text`, `file_ref`, `occurred_at`, `uploaded_at`, `uploaded_by`, `source_role`, `service_record_id`, `content_hash`, `processing_status`, `processing_version`, `sensitivity_level`, `source_version`, `extractor_version`, `last_batch_id`, `notes`, `created_at`, `updated_at`。

V1 输入：`TEXT_INPUT`、`VOICE_TRANSCRIPT`、`PASTED_TRANSCRIPT`、`SERVICE_TRANSCRIPT`、`IMPORTED_TEXT`，以及通过临时后端提取后写入 `raw_text` 的 `.txt`、`.md`、`.markdown`、`.docx` 文件。文件只在请求处理期间存在，不写入 Feishu Drive 或其他永久文件存储；`file_ref` 仅保存文件名、类型、大小、字符数和文件哈希等元数据。

文件提取 V1 明确不支持 PDF、旧版 DOC、图片、扫描件和 OCR。文件选择、服务端校验、文本提取和 Source 保存使用统一错误文案：`当前支持 TXT、Markdown 和 Word（.docx）文件。`；读取失败使用：`资料读取失败，请检查文件后重新上传。`

默认 `sensitivity_level=HIGH`。普通日志、Debug 和列表接口不输出 `raw_text` 全文；Source 详情仅 ADMIN 可访问。

# SourceRecord V1

逻辑实体 `SourceRecord`，对应 Feishu 表 `ASVA 客户原始资料`。原始文本是不可悄悄覆盖的依据；文本修正使用新版本而非覆盖旧资料。

## 核心字段

`source_id`, `subject_type`, `subject_id`, `customer_id`, `source_type`, `title`, `raw_text`, `file_ref`, `occurred_at`, `uploaded_at`, `uploaded_by`, `source_role`, `service_record_id`, `content_hash`, `processing_status`, `processing_version`, `sensitivity_level`, `source_version`, `extractor_version`, `last_batch_id`, `notes`, `created_at`, `updated_at`。

V1 输入：`TEXT_INPUT`、`VOICE_TRANSCRIPT`、`PASTED_TRANSCRIPT`、`SERVICE_TRANSCRIPT`、`IMPORTED_TEXT`。音频、PDF、DOCX、聊天导出只保留未来类型，不在本阶段解析或存储原文件。

默认 `sensitivity_level=HIGH`。普通日志、Debug 和列表接口不输出 `raw_text` 全文；Source 详情仅 ADMIN 可访问。

# EvidenceExtractor

统一入口：`SourceRecord → EvidenceExtractor → Evidence Candidates → Review`。Extractor 只接收当前 Source 文本、必要的 Customer Current Snapshot 和 Schema Registry，不默认带入全部历史原始资料。

长文本按自然段切 chunk；每个 chunk 独立提取，之后按类型、字段、值和原文摘录去重。每次分析都有 `extraction_batch_id`、provider、model、model_version、prompt_version。JSON 先做严格 Schema Validate，失败不部分写入 Evidence；Source 保留并标记 `FAILED`，可重试。

AI 不能直接 update Customer。`HYPOTHESIS` 永远只展示参考，不进入 Current Snapshot。只有明确属于导师记录的 Source 才允许 `OBSERVATION`。

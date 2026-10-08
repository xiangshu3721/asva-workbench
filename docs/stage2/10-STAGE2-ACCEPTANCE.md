# Stage 2 Acceptance

人工验收入口在 Customer Detail 的“资料与依据”：文字补充、语音补充、粘贴原始资料；保存后先得到资料已保存反馈，再查看 Fact、Self Meaning、Observation、Hypothesis、Proposal、Conflict、Source 列表和依据。

必须确认：原文不丢、Evidence 可回 Source、AI 不直写 Customer、状态变化与稳定事实冲突分开、人工确认后 Customer 与 ProfileChanges 可回读、重复 Source 被提醒、AI 失败可重试。Debug 只显示 source_id、processing_status、batch、计数、model、prompt_version、duration，不显示 raw_text。

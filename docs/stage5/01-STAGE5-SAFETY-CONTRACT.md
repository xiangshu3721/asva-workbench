# Stage 5｜SafetyAssessmentV1 Contract

## 数据边界

安全上下文只包含当前快照、可靠已确认 Evidence 摘要、必要 Life Event、Stage4 当前议题/知识缺口、Evidence 引用和上下文密度。不得包含姓名、手机号、微信号、完整原始资料或无关业务信息。

## 信号字段

每个候选信号必须声明：`signal_type`、`subject_scope`、`polarity`、`explicitness`、`recency`、`severity`、`confidence`、`evidence_refs`。主体分为 `SELF/OTHER/UNKNOWN`；不能把第三方风险归到客户本人。否定、历史表达和不确定表达必须保留原语义。

## 评估字段

`SafetyAssessmentV1` 包含 `status`、`context_density`、`safety_data_sufficiency`、`risk_level`、`risk_confidence`、`service_gate`、`commercial_block`、`requires_human_review`、`requires_safety_check`、`recommended_escalation`、`critical_unknowns`、`allowed_actions`、`avoid_actions`、`service_cautions`、`next_action`、`safety_signals` 和 `hard_rule_hits`。

当前实现优先复用客户元数据中的 `_safety` 区域；预留可选 `FEISHU_SAFETY_ASSESSMENTS_TABLE_ID`，未配置时不强制扩生产表。


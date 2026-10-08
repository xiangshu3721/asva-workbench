# Evidence Model V1

逻辑实体 `EvidenceItem`，对应 Feishu 表 `ASVA 客户证据`。一条 Evidence 只表达一个相对原子的内容，并且必须通过 `source_id` 回到 Source；文本定位至少保存 excerpt 与 character/paragraph locator。

`evidence_type` 严格使用 `FACT`、`SELF_MEANING`、`OBSERVATION`、`HYPOTHESIS`。`semantic_kind` 使用 `PROFILE_FIELD`、`CURRENT_STATE`、`EVENT`、`RELATIONSHIP`、`RESOURCE`、`NEED`、`GOAL`、`PREFERENCE`、`OTHER`。EVENT 可以是 `evidence_type=FACT`、`semantic_kind=EVENT`，不在本阶段制作 Life Event 产品页。

Evidence immutable：错误内容标记 `REJECTED` 或 `SUPERSEDED`，不原地改变原文。

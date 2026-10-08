# Stage 2 Integration Test

真实 Feishu 验收使用 `STAGE2_IT_<random>`，只创建临时 Source、Evidence、Proposal、Conflict 与 Customer 更新，完成回读后清理精确 ID。

场景：南京→杭州、出生日期冲突、客户 SELF_MEANING、导师 OBSERVATION、AI HYPOTHESIS、重复 content_hash、长文本 chunk、AI 失败后重试。每条结果记录 HTTP 状态、request_id、record_id 与最终状态，不记录原文全文、密钥或完整 Token。

## 最终批次结果

- Stage 2 四表已真实创建，Schema Check PASS。
- 根因批次定位为既有 `ProfileChanges` 表的 Provenance V2 写入：`source_record_id`、`evidence_id`、`update_batch_id` 未经过 Mapping，原样发送为不存在的 Feishu 字段名，返回 `1254045 FieldNameNotFound`。
- 修复后补齐 `资料ID`、`证据ID`、`更新批次ID`，并通过 Mapping、Schema Contract 与回归测试。
- 最终批次：`STAGE2_IT_1791432258035_99bc26`。
- ADMIN operator Source：PASS；customer self-report Source：PASS；`VOICE_TRANSCRIPT`、`PASTED_TRANSCRIPT`、`SERVICE_TRANSCRIPT`：PASS；重复 content_hash 拒绝：PASS。
- Evidence real write/reload：PASS；FACT、SELF_MEANING、OBSERVATION、HYPOTHESIS：PASS；MENTOR source real write：PASS；MENTOR `OBSERVATION` 类型与 `source_role=MENTOR`：PASS。
- Proposal real write：PASS；ADD/UPDATE/REVIEW_REQUIRED 路径：PASS；人工确认：PASS；Customer Update：PASS。
- `POSSIBLE_STATE_CHANGE` 与 `FACT_CONTRADICTION`：PASS；人工解决后开放冲突为 0。
- Provenance V2：PASS；ProfileChanges source/evidence links：PASS。
- Source reload：PASS；精确清理：PASS；`evidence:data-check`：PASS，当前无 Stage 2 残留。
- 中途曾遇到 Feishu `99991400 request trigger frequency limit`，仅对读请求增加退避重试；未忽略字段错误，也未自动重试写入。

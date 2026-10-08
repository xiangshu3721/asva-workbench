# ASVA Stage 2 Completion Report

状态：`CODE_READY_FOR_PRODUCTION`

基线：R003；`STAGE2_CODE_READY_FOR_PRODUCTION = YES`。浏览器人工 Smoke 与 R004 Production Closure 仍未执行，因此 `STAGE2_PRODUCTION_VERIFIED = NO`。

## 当前实现

- SourceRecord、EvidenceItem、ProfileUpdateProposal、EvidenceConflict 契约与 API 已加入。
- Source 原文先持久化，AI 提取随后处理；支持 chunk、batch、locator、dedup、失败标记与重试。
- Customer Detail 已加入文字、语音、粘贴三种资料入口及人工审核界面。
- 人工确认通过既有 Customer Profile 更新链路，并写入 Source/Evidence Provenance。

## 集成阻塞修复结果

- 根因：既有 `ProfileChanges` 的 Provenance V2 写入包含 `source_record_id`、`evidence_id`、`update_batch_id`，但 Mapping 未定义这三个 internal key，适配器把它们原样作为英文 Feishu field name 发送。
- Feishu 目标：`ProfileChanges`；错误字段名：`source_record_id`、`evidence_id`、`update_batch_id`；错误码：`1254045 FieldNameNotFound`。
- Schema Check 未提前发现：旧 Mapping/Contract 没有这三个字段，因此检查集本身没有期望它们。
- 修复：新增批准的 `资料ID`、`证据ID`、`更新批次ID` 三个 Text 字段到既有 `ProfileChanges` 表，并同步更新 Field Mapping、Schema Contract、Provenance 写入和回归测试。
- 没有新增 Stage 2 表；发生的是已批准 Provenance V2 的既有表 Schema 补齐。
- 最终真实批次 `STAGE2_IT_1791432258035_99bc26`：TEXT/VOICE/PASTED/SERVICE Source、Evidence、Proposal、人工确认、Customer 更新、Provenance/ProfileChanges、`POSSIBLE_STATE_CHANGE`、`FACT_CONTRADICTION`、MENTOR Observation、Source reload、清理均 PASS，开放冲突为 0。
- MENTOR 在本链路中是 `source_role / observer_role`，不是登录用户；操作人是 ADMIN，导师登录仍禁止。
- 四张 Production Feishu Stage 2 表已幂等创建并通过 Schema Check；尚未随 R004 部署到 Production Backend。
- 浏览器逐项人工验收待执行；R004 Production Closure 未授权，本轮不发布。
- R004 Production Closure 未授权，本轮不发布。

## 验证结果

- 自动测试：143/143 PASS
- Typecheck：PASS
- Build：PASS，Release Counter 保持为 R003
- 全量 Schema Check：PASS；ProfileChanges 与四张 Stage 2 表均无 missing/extra/type mismatch
- Stage 2 Data Quality：PASS，最终批次清理后无残留
- 真实 Feishu Integration：PASS
- Browser Manual Acceptance：NOT RUN
- `STAGE2_INTEGRATION_READY = YES`
- `STAGE2_CODE_READY_FOR_PRODUCTION = YES`
- `STAGE2_PRODUCTION_VERIFIED = NO`

## Stage 1 冻结说明

Stage 1 的 R003 基线和人工验收结论沿用已提供的验收记录。本轮只读复核 Production health：`AUTH_MODE=PASSWORD`、`DATA_MODE=production`、`adminAuthConfigured=false`、Release R003；未执行 CloudBase 配置写入。health 不回显环境变量，因此旧 `ASVA_ADMIN_LOGIN_CODE` 是否仍存在无法由接口确认，保留为 `SECURITY_CLEANUP_PENDING`，待下一次 Password Production Closure 时处理。

## Stage 3 留项

正式 OTP/企业身份认证、Mentor 权限、ServiceCase、Living Model、Clinical Risk、Development Lens、复杂 OCR/文件解析、消息队列、BI 与多主体系统。

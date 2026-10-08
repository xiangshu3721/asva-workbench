# ASVA Stage 1 Completion Report

Stage 1 Customer Data Foundation V1 已完成代码、真实 Feishu 验收与清理。产品负责人已完成真实使用验收；少量非阻塞 UX 问题进入 `docs/backlog/STAGE1-BACKLOG.md`，本阶段冻结。

本阶段不扩大到 Stage 2。Production 内测认证仍标记为 `TEMPORARY_INTERNAL_AUTH`：当前仅允许 ACTIVE ADMIN 使用服务端 `AUTH_MODE=ADMIN_CODE`，正式客户数据、导师端开放、外部公开使用或解忧小屋上线前必须替换为正式 OTP / 企业身份认证。

## 结果摘要

- Branch：`production-r002`（R003 Production 基线）
- 基线：Production R003 commit `9174c8107e562699c8e749653ec0831121dc16b4`
- Customer Schema V1：代码映射与字段分类文档完成；Production Customers 已创建 `出生日期` DateTime 字段，Schema Check PASS；`导师ID` 保留为 deprecated 只读兼容字段
- Identity Resolver：phone / WeChat normalize、exact、possible、conflict、contact required 完成
- Customer CRUD：本地 create/read/update、Profile Version、Provenance、ProfileChanges 完成并通过自动测试
- Enrollment：本地与真实 Feishu active Product、单/多课程、去重、ADD/KEEP/REMOVE、`CANCELLED` 恢复和刷新回读均通过
- AI boundary：Draft → 人工确认；未确认 AI 不写入事实
- Legacy boundary：`current_mentor_id` 新写；`导师ID` 仅兼容读取；Customer create/update 不创建 Appointment
- 自动测试：121/121 PASS
- Typecheck：PASS
- Build：PASS，Release Counter 保持为 R003
- Schema Check：PASS；Customers 103 fields，缺失/类型不匹配为 0，`导师ID` 仅列为 deprecated
- Data Quality：PASS；14 Customers、8 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments；所有质量问题指标为 0
- Feishu 集成：PASS；批次 `STAGE1_IT_1791385895823_ae0e0e` 真实创建、回读、更新、Enrollment/历史变更和清理完成；失败批次残留也已按精确 ID 清理
- 手工产品负责人验收：`PASS_WITH_MINOR_ISSUES`
- Production 认证基线：PASSWORD；Stage 0 临时 ADMIN_CODE 不再作为登录入口

## 当前 FAIL / BLOCKED

1. 少量 UX 细节列入 Stage 1 backlog，不阻塞 Stage 2 Evidence Foundation。

## 明确留后续

ServiceCase、正式 OTP、导师端登录、预约新流程、Evidence Engine、Conflict Engine、Insight / Lens、临床风险与商业评分均不属于本阶段。

`MANUAL_PRODUCT_OWNER_ACCEPTANCE = PASS_WITH_MINOR_ISSUES`

`STAGE1_COMPLETE = YES`

`BASELINE_RELEASE = R003`

Stage 1 不执行 `release:prepare`、Production merge、Pages deploy 或 CloudBase deploy。

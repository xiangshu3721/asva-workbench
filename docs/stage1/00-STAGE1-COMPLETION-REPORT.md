# ASVA Stage 1 Completion Report

Stage 1 Customer Data Foundation V1 已完成代码、真实 Feishu 验收与清理；浏览器逐项人工验收因当前 CUA 桥接初始化超时仍未完成，因此本报告不宣告 Production-ready。

本阶段不扩大到 Stage 2。Production 内测认证仍标记为 `TEMPORARY_INTERNAL_AUTH`：当前仅允许 ACTIVE ADMIN 使用服务端 `AUTH_MODE=ADMIN_CODE`，正式客户数据、导师端开放、外部公开使用或解忧小屋上线前必须替换为正式 OTP / 企业身份认证。

## 结果摘要

- Branch：`stage-1-customer-foundation`
- 基线：Production R001 commit `7fc21190f76e59e5b6017877e58b12292473158a`
- Customer Schema V1：代码映射与字段分类文档完成；Production Customers 已创建 `出生日期` DateTime 字段，Schema Check PASS；`导师ID` 保留为 deprecated 只读兼容字段
- Identity Resolver：phone / WeChat normalize、exact、possible、conflict、contact required 完成
- Customer CRUD：本地 create/read/update、Profile Version、Provenance、ProfileChanges 完成并通过自动测试
- Enrollment：本地与真实 Feishu active Product、单/多课程、去重、ADD/KEEP/REMOVE、`CANCELLED` 恢复和刷新回读均通过
- AI boundary：Draft → 人工确认；未确认 AI 不写入事实
- Legacy boundary：`current_mentor_id` 新写；`导师ID` 仅兼容读取；Customer create/update 不创建 Appointment
- 自动测试：121/121 PASS
- Typecheck：PASS
- Build：PASS，未增加 Release Counter，仍为 R001
- Schema Check：PASS；Customers 103 fields，缺失/类型不匹配为 0，`导师ID` 仅列为 deprecated
- Data Quality：PASS；14 Customers、8 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments；所有质量问题指标为 0
- Feishu 集成：PASS；批次 `STAGE1_IT_1791385895823_ae0e0e` 真实创建、回读、更新、Enrollment/历史变更和清理完成；失败批次残留也已按精确 ID 清理
- 浏览器人工验收：BLOCKED；本地服务可用，但 CUA 状态初始化连续超时，未将静态/HTTP 检查冒充点击通过
- Production merge / deploy：未执行

## 当前 FAIL / BLOCKED

1. 必须在可用的浏览器自动化/设备环境中完成 Customer list/detail、搜索、Enrollment 刷新、Debug Mode、AI Brief、AI Query 与 Appointment 未创建的点击验收。

## 明确留后续

ServiceCase、正式 OTP、导师端登录、预约新流程、Evidence Engine、Conflict Engine、Insight / Lens、临床风险与商业评分均不属于本阶段。

`STAGE1_READY_FOR_PRODUCTION = NO`

Stage 1 不执行 `release:prepare`、Production merge、Pages deploy 或 CloudBase deploy。

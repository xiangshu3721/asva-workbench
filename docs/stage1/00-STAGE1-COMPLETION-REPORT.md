# ASVA Stage 1 Completion Report

Stage 1 Customer Data Foundation V1 已完成代码与本地自动化收口，但尚未达到 Production-ready。

## 结果摘要

- Branch：`stage-1-customer-foundation`
- 基线：Production R001 commit `7fc21190f76e59e5b6017877e58b12292473158a`
- Customer Schema V1：代码映射与字段分类文档完成；新增字段规则见 `CUSTOMER_SCHEMA_CHANGE_RULES.md`
- Identity Resolver：phone / WeChat normalize、exact、possible、conflict、contact required 完成
- Customer CRUD：本地 create/read/update、Profile Version、Provenance、ProfileChanges 完成并通过自动测试
- Enrollment：本地 active Product、单/多课程、去重完成并通过自动测试；真实写入未通过
- AI boundary：Draft → 人工确认；未确认 AI 不写入事实
- Legacy boundary：`current_mentor_id` 新写；`导师ID` 仅兼容读取；Customer create/update 不创建 Appointment
- 自动测试：119/119 PASS
- Typecheck：PASS
- Build：PASS，未增加 Release Counter，仍为 R001
- Schema Check：PASS；无 Missing / Extra / TypeMismatch
- Data Quality：FAIL；当前有 1 条 Customer 缺少手机号和微信号，其余检查项为 0
- Feishu 集成：BLOCKED；门控脚本先生成 `stage1-backup/` 快照，但 HTTP Customer 写入后回读收到 `FEISHU_UNAVAILABLE`，不能视为 PASS
- 浏览器人工验收：BLOCKED / 未完成
- Production merge / deploy：未执行

## 当前 FAIL / BLOCKED

1. 必须先人工确认并处理既有 1 条无联系方式 Customer，或形成明确例外迁移决策。
2. 必须定位并重跑真实 Feishu Customer / Enrollment / ProfileChange 集成回读，当前不能把局部写入后的 `FEISHU_UNAVAILABLE` 视为成功。
3. 必须完成 Customer list/detail、搜索、Enrollment 刷新、Debug Mode、AI Brief 与 Appointment 未创建的浏览器验收。
4. 本次失败的随机 `STAGE1_TEST_` 记录未自动删除，避免未经确认执行破坏性清理；后续应按快照核对后处理。

## 明确留后续

ServiceCase、正式 OTP、导师端登录、预约新流程、Evidence Engine、Conflict Engine、Insight / Lens、临床风险与商业评分均不属于本阶段。

`STAGE1_READY_FOR_PRODUCTION = NO`

Stage 1 不执行 `release:prepare`、Production merge、Pages deploy 或 CloudBase deploy。

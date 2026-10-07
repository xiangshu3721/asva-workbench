# Stage 1 Acceptance

| Area | Status | Note |
|---|---|---|
| Customer Schema V1 | PASS | 字段族、属性与新增规则已冻结 |
| Identity Resolver | PASS | phone/wechat normalize、exact、possible、conflict 已实现并测试 |
| Customer CRUD | BLOCKED | 本地 CRUD、Profile Version、Provenance、ProfileChanges 自动测试通过；真实 Feishu Customer HTTP 写入后回读收到 `FEISHU_UNAVAILABLE`，未宣称集成通过 |
| Enrollment | BLOCKED | 本地单双课程与去重通过；真实 Feishu 多 Enrollment 写入因上述 Customer 集成回读阻断，未宣称通过 |
| AI boundary | PASS | Draft → 人工确认；未确认 AI 不写事实 |
| Legacy boundary | PASS | Appointment 关闭；Customer 新增不创建 Appointment；`current_mentor_id` 新写 |
| Data quality | FAIL | 当前检查仍有 1 条 Customer 缺少手机号和微信号；其余重复与悬空引用为 0 |
| Regression | PASS | 119/119、typecheck、build、schema check PASS；浏览器点击验收未完成 |

本文件在 Stage 1 最终验收前不得改成全绿。

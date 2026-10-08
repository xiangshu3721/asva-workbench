# Stage 1 Acceptance

| Area | Status | Note |
|---|---|---|
| Customer Schema V1 | PASS | Production Customers 已创建 `出生日期` DateTime；Missing / Extra / TypeMismatch 为 0，`导师ID` 仅为 deprecated 兼容字段 |
| Identity Resolver | PASS | phone/wechat normalize、exact、possible、conflict 已实现并测试 |
| Customer CRUD | PASS | 真实批次完成 create/readback/update/refresh、phone-only、WeChat-only、duplicate、possible match、identity conflict、幂等重试 |
| Enrollment | PASS | 真实批次完成单/多课程、重复防止、编辑、CANCELLED、restore、refresh recovery |
| AI boundary | PASS | Draft → 人工确认；未确认 AI 不写事实 |
| Legacy boundary | PASS | Appointment 关闭；Customer 新增不创建 Appointment；`current_mentor_id` 新写 |
| Data quality | PASS | 最终 Customer Data Check 全部指标为 0；STAGE1_TEST_/STAGE1_IT_/Cloudflare 指定目标均已清理 |
| Regression | BLOCKED | 121/121、typecheck、build、schema check PASS；浏览器点击验收因 CUA 初始化超时未完成 |

本文件保留 Browser Acceptance BLOCKED，不将静态/HTTP 检查冒充人工点击通过。

# ASVA Stage 0 Completion Report

报告时间：2026-10-07（Asia/Shanghai）
分支：`stage-0-foundation`
Production release：`R001`
最终 commit：`f38bfc1f656cae769342cd61cff35127f5ace141`

## 结论

`STAGE0_READY_FOR_STAGE1 = YES`

Stage 0 Production Closure 已完成。本轮到此停止，不进入 Stage 1。

## R001 发布闭环

| 门槛 | 结果 | 证据 |
|---|---|---|
| FE R001 | PASS | Pages Actions run `37623738257`，commit `f38bfc1`，conclusion `success` |
| BE R001 | PASS | CloudBase `/api/health` 返回 `R001`，commit `f38bfc1` |
| VERSION_MATCH | YES | FE/BE release counter 均为 1，FE/BE commit 均为 `f38bfc1` |
| Production Data Mode | PASS | health `environment=production`、`dataMode=production` |
| Production Source | PASS | health `feishuConfigured=true`；生产 dashboard 返回真实 Feishu 数据结构 |
| Demo fallback | disabled | health/部署变量 `ALLOW_DEV_OTP=false`；Production 不接受 `888888` |
| External appointment | PASS | Production 返回 403 `FEATURE_DISABLED` |
| Public frontend | PASS | Pages HTTP 200，title `ASVA 工作台`，引用 hashed JS asset 可读取 |

## Production Auth

当前模式：`AUTH_MODE=ADMIN_CODE`，标记为 `TEMPORARY_INTERNAL_AUTH`，只用于 Stage 0 / 内测，不是长期正式认证。

- `ASVA_AUTH_SECRET`：CloudBase Production 已配置；服务端签发 8 小时 HMAC Session。
- `ASVA_ADMIN_LOGIN_CODE`：CloudBase Production 已配置；只在服务端校验，不进入 Git、源码、bundle、日志、API 响应或 Debug Panel。
- 登录成功：必须同时满足手机号存在、`ADMIN`、`ACTIVE`、`login_enabled=true`、管理员码正确；实测返回 200 和 signed Session。
- 登录失败统一返回 `401 / AUTH_INVALID / 登录信息验证失败`；不存在账号、MENTOR、错误管理员码均不泄露具体原因。
- `X-Staff-Id` 单独请求、非法 token、无 token 均返回 401。
- 登出由前端清除 `sessionStorage` token；生产 staff UI 状态也不再写入 localStorage。
- 防暴力破解：服务端按 `phone + IP` 内存限流，15 分钟最多 5 次；同一测试键实测 `[401,401,401,401,401,429]`。这是正式外部使用前的技术债。
- Debug Panel 仅 ADMIN 可见，显示 `Auth Mode: ADMIN_CODE`、`Auth State: AUTHENTICATED`、`Role: ADMIN`，不显示实际 Login Code。
- MENTOR 当前仍禁止登录。

正式 OTP / 企业身份认证替换条件：在第一批真实客户数据进入系统、导师端正式开放、外部公开使用或解忧小屋正式上线任一条件发生前，必须替换当前 `TEMPORARY_INTERNAL_AUTH`；未来接口预留 `AUTH_MODE=SMS_OTP`。

## 自动检查与回归

- `npm test`：111/111 PASS（原 Stage 0 基线测试 + 登录限流回归）。
- `npm run typecheck`：PASS。
- `npm run build`：PASS。
- `npm run schema:check`：PASS；Missing/Extra/TypeMismatch 均为零，`导师ID` 仍按 deprecated 管理。
- Production health、管理员登录、Session、固定码拒绝、MENTOR 拒绝、伪造身份拒绝、401 错误、限流、feature flag：PASS。
- Production Feishu 与既有 AI 生产回归证据保留；本轮未重复触发会向外部 AI 服务发送生产数据的调用。
- 真实写入测试使用 `STAGE0_TEST_`，已完成写入前快照、request_id、刷新读回；写入内容未进入 Git。

## 真实数据写入结果

- 写入前快照：`stage0-backup/feishu-snapshot-2026-10-07T11-22-54-712Z.json`，目录已加入 `.gitignore`。
- 已复核 6 个 `STAGE0_TEST_` 客户、2 名已停用测试导师、2 个报名、2 条 ServiceRecord（A/B）、AI summary、城市南京→杭州、职业更新、5 条 ProfileChanges。
- 自动脚本在最终全量刷新处超时；独立只读复核返回 `ok=true`，因此记录为“写入链路通过、自动汇总超时”，不冒充完整 E2E 全绿。

## Stage 0 未进入范围

未做 12 层 Life OS、临床风险、新 SABC、BI、今日关怀 AI、Lens、多主体、八字、新 CRM/营销、新预约业务、全量 Repository 重写、Appointment 新表/状态迁移及 Stage 1 功能扩展。

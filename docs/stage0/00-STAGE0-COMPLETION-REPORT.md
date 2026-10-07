# ASVA Stage 0 完成报告

报告时间：2026-10-07（Asia/Shanghai）
分支：`stage-0-foundation`
范围：生产底座、调试体系、版本治理、数据/认证/Schema 契约；未进入 Stage 1 业务扩展。

## 结论

`STAGE0_READY_FOR_STAGE1 = NO`

代码底座和真实 Feishu 测试数据写入已完成，但生产发布门槛尚未全部满足：`.env.local` 尚未配置 `ASVA_AUTH_SECRET`，因此部署脚本会主动阻止生产发布；公开 Pages/CloudBase 仍是 Stage 0 开始前版本，尚未进行本分支发布后的 FE/BE release match 验收。

## Before / After

| 领域 | Before | After |
|---|---|---|
| Git | `github-pages-clean2`，无 Stage 0 分支 | `stage-0-foundation`，起点 `314d39c` |
| Release | 无统一计数/health metadata | `release.json`、`release:prepare`、build metadata、R000 health |
| API health | service 为 `asva-workbench`，无版本 | `service=asva-api`，包含 appVersion/release/git/build/environment |
| 错误 | 不统一，缺 request id | 非 2xx + `success/code/message/request_id`，响应 `X-Request-Id` |
| 身份 | 可伪造 `X-Staff-Id` | production 只接受 HMAC Bearer Session；demo 保留兼容 |
| CORS | `*` | 只允许 `ASVA_FRONTEND_ORIGIN` |
| 数据模式 | 本地回退边界不明确 | `production/demo` 明确隔离，production 不读本地回退 |
| Schema | 映射存在但无 contract/check | contract + `npm run schema:check`，deprecated/真实类型显式输出 |
| 日期 | 业务和 Feishu 转换分散 | `date-contract.mjs` + mapping adapter 统一处理 |
| 调试 | 无安全面板 | 默认关闭、5 次点击/`?debug=1`、ADMIN-only、内存 20 条请求记录 |

## 已改动与明确未改动

已改动：版本、health、认证/CORS、错误/request-id、Debug、Error Boundary、DATA_MODE、Schema/date adapter、外部预约 feature flag、幂等 operation id、部分写入错误码、Stage 0 文档和 gated integration script。

未做：12 层 Life OS、临床风险、心理学/新 SABC、BI、今日关怀 AI、Lens、多主体、八字、新 CRM/营销、新预约业务、全量 Repository 重写、Appointment 新表/状态迁移。

## 真实数据写入结果

- 写入前快照：`stage0-backup/feishu-snapshot-2026-10-07T11-22-54-712Z.json`，目录已加入 `.gitignore`。
- 已复核现场存在 6 个 `STAGE0_TEST_` 客户、2 名 `STAGE0_TEST_` 测试导师且均已停用、2 个报名、2 条 ServiceRecord（A/B）、AI summary、城市南京→杭州、职业更新、5 条 ProfileChanges。
- 自动脚本在最终全量刷新处超时，未把它标成全绿；独立只读复核返回 `ok=true`。这是“写入链路通过、脚本最终汇总超时”，不是完整 E2E 全通过。

## 自动检查

- `npm run typecheck`：通过。
- `npm test`：109/109 通过（原有 106 项保持通过，新增 Stage 0 contract 3 项）。
- `npm run build`：通过。
- `npm run schema:check`：现场 Missing/Extra/TypeMismatch 已校准为零；`导师ID` 作为 deprecated 输出。
- 本地 `/api/health`：R000、`service=asva-api`、metadata 完整。
- 本地错误接口：HTTP 404、标准 JSON、`X-Request-Id` 已验证。

## P0 / P1 / P2

- P0：配置高强度 `ASVA_AUTH_SECRET`，再部署 production；当前部署脚本会拒绝缺失密钥。
- P1：配置生产真实 OTP 服务；production 不再接受固定 `888888`。
- P1：按同一 release counter 构建并发布 Pages + CloudBase，完成公开 health、Pages assets、FE/BE match 验收。
- P1：将真实写入脚本的 Feishu 慢请求拆分/增加超时与重试状态，避免最终全量刷新阻塞报告。
- P2：补充浏览器点击级 Debug drawer、production/demo 页面可视验收；静态 build 不代替浏览器验收。

## 发布边界

本轮没有 push、没有部署、没有修改公开 Pages/CloudBase。当前结果是可审计的 Stage 0 本地分支与现场测试数据证据，待 P0 配置和外部发布授权后再进入 release 验收。

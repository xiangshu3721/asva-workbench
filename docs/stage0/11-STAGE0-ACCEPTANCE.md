# Stage 0 Acceptance

## 必过门槛

- [x] `npm test` 原有 106 项全部通过；R001 认证限流回归测试通过。
- [x] `npm run typecheck`、`npm run build` 通过。
- [x] `npm run schema:check` 无未登记 Missing/Extra/TypeMismatch；Deprecated 有明确处置。
- [x] production/demo 模式隔离，production 不读本地回退。
- [x] production CORS 非 `*`，固定 OTP 被拒绝，Session 签名有效，导师被拒绝；管理员码入口满足 ADMIN/ACTIVE/login_enabled。
- [x] API 错误为非 2xx + `{success:false,code,message,request_id}`；响应带 `X-Request-Id`。
- [x] Debug 默认关闭，ADMIN 才能看安全调试信息，且不显示实际登录码。
- [x] external appointment 默认 403 `FEATURE_DISABLED`。
- [x] 部署后完成 CloudBase health、Pages HTML/assets、FE/BE release match 检查。
- [x] 真实写入测试使用 `STAGE0_TEST_`，并有快照、request_id、刷新后的读回证据。

## 当前状态

当前结论详见 `00-STAGE0-COMPLETION-REPORT.md`。浏览器点击级验收仍须与 API/构建证据分开记录，不用静态代码替代。

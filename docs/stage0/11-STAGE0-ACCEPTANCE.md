# Stage 0 Acceptance

## 必过门槛

- [ ] `npm test` 原有 106 项全部通过。
- [ ] `npm run typecheck`、`npm run build` 通过。
- [ ] `npm run schema:check` 无未登记 Missing/Extra/TypeMismatch；Deprecated 有明确处置。
- [ ] production/demo 模式隔离，production 不读本地回退。
- [ ] production CORS 非 `*`，固定 OTP 被拒绝，Session 签名有效，导师被拒绝。
- [ ] API 错误为非 2xx + `{success:false,code,message,request_id}`；响应带 `X-Request-Id`。
- [ ] Debug 默认关闭，ADMIN 才能看安全调试信息。
- [ ] external appointment 默认 403 `FEATURE_DISABLED`。
- [ ] 部署后完成 CloudBase health、Pages HTML/assets、FE/BE release match 检查。
- [ ] 真实写入测试使用 `STAGE0_TEST_`，并有快照、request_id、刷新后的读回证据。

## 当前状态

当前结论详见 `00-STAGE0-COMPLETION-REPORT.md`：`STAGE0_READY_FOR_STAGE1 = NO`。公开部署、真实写入、物理设备和浏览器点击验收不得用静态代码替代。

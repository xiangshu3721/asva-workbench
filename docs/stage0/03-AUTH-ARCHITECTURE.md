# Auth Architecture

## Stage 0 临时边界

当前 Production 认证模式为 `AUTH_MODE=ADMIN_CODE`，明确标记为 `TEMPORARY_INTERNAL_AUTH`，仅用于 ASVA Stage 0 / 内测阶段，不是长期正式认证方案。

- 登录必须同时满足：手机号存在于 ASVA 人员、`role=ADMIN`、`status=ACTIVE`、`login_enabled=true`，以及服务端 `ASVA_ADMIN_LOGIN_CODE` 校验成功。
- `ASVA_ADMIN_LOGIN_CODE` 只配置在 CloudBase Production 环境变量；不进入 Git、源码、前端 bundle、日志、API 响应或 Debug Panel。泄露时只需修改 CloudBase 环境变量并重新部署。
- 登录码只在服务端校验；成功后由服务端使用 `ASVA_AUTH_SECRET` 签发 8 小时 HMAC Session。后续 API 必须通过 `requireAuth` / `requireAdmin` 等效 guard 验证 Bearer Session；非法或过期 token 返回 401。
- production 忽略 `X-Staff-Id`，不接受 localStorage 伪造身份；前端只在 `sessionStorage` 保存会话与临时 staff UI 状态。
- 固定 `888888` 只允许 `ALLOW_DEV_OTP=true` 且环境不是 production；Production `ALLOW_DEV_OTP=false`，没有开发认证 fallback。MENTOR 永远不能登录当前管理员端。
- 登录失败统一对外返回“登录信息验证失败”，不暴露手机号是否存在、人员状态或是登录码错误。失败次数按 `phone + IP` 计，15 分钟最多 5 次，当前为服务端内存限流。
- `AUTH_MODE=SMS_OTP` 作为未来正式 OTP 的替换接口保留；当前未启用 SMS provider。

## Debug Mode

Debug Panel 默认关闭且只允许 ADMIN 查看。可显示：`Auth Mode: ADMIN_CODE`、`Auth State: AUTHENTICATED`、`Role: ADMIN`、版本、数据源与请求摘要；绝不显示实际 Login Code、JWT、完整手机号或聊天正文。

## 替换技术债

在以下任一条件发生前，必须替换为正式 OTP / 企业身份认证：

- 第一批真实客户数据进入系统
- 导师端正式开放
- 外部公开使用
- 解忧小屋正式上线

当前内存限流也需在正式外部使用前替换为持久化或网关级限流。

部署前必须配置高强度 `ASVA_AUTH_SECRET` 与 Production `ASVA_ADMIN_LOGIN_CODE`；部署脚本在缺失时拒绝发布，且不会打印任何 secret 值。

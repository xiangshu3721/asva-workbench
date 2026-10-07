# Auth Architecture

- 登录成功后服务端使用 `ASVA_AUTH_SECRET` HMAC 签发 8 小时 Session；前端只在 `sessionStorage` 保存 token，不接受客户端自造 staff 身份。
- production 忽略 `X-Staff-Id`，内部 API 必须携带 Bearer Session；demo 可保留旧 header 供本地测试。
- `guard` 负责有效登录，`guardAdmin` 负责 ADMIN 与 ACTIVE；导师账号继续拒绝进入管理员工作台。
- 固定 `888888` 只允许 `ALLOW_DEV_OTP=true` 且环境不是 production；production 未接真实验证码服务时明确返回 `AUTH_OTP_NOT_CONFIGURED`，不假装登录成功。
- production CORS 只允许 `ASVA_FRONTEND_ORIGIN`，默认公开前端域名，不使用 `*`。

部署前必须配置高强度 `ASVA_AUTH_SECRET`；部署脚本在缺失时拒绝发布。

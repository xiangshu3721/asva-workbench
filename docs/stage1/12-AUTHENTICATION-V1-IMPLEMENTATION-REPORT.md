# ASVA Authentication V1 Implementation Report

日期：2026-10-08
范围：仅认证准备与真实 Feishu Production 凭据集成；未切换 Production 认证模式、未部署代码、未发布 R002、未合并 Stage 1、未进入 Stage 2。

## 结论

- `AUTH_V1_CODE_READY = YES`
- `STAGE1_CODE_READY_FOR_PRODUCTION = NO`：Stage 1 浏览器点击级人工验收仍因 CUA 初始化超时未完成；本轮没有把静态检查或 HTTP 检查冒充浏览器 PASS。
- 当前 Production 仍保持 `R001 / AUTH_MODE=ADMIN_CODE / DATA_MODE=production / ALLOW_DEV_OTP=false`。本轮没有切换 `AUTH_MODE`，没有删除 `ASVA_ADMIN_LOGIN_CODE`，没有 CloudBase 代码部署。
- Release Counter 保持 `R001`。

## AuthCredential Production 准备

- 已在同一 Feishu Production Base 创建独立认证表 `ASVA 登录凭据`，不使用 CloudBase 数据库，不写入 Staff、Customer 或 ProfileChanges。
- 已创建并回读认证字段：凭据身份、Staff 关联、登录手机号、scrypt 哈希、算法、首次改密、认证版本、密码时间、登录时间、凭据状态、创建/更新时间。
- CloudBase Production 已配置认证表 ID；仅验证配置存在，不记录或回显任何 Secret、密码、哈希或完整 Token。
- `AUTH_MODE=PASSWORD` 没有凭据表时 fail-closed，不回退 `ADMIN_CODE`。
- AuthCredential 数据检查：PASS；3 条凭据、1 条 ACTIVE、0 条异常。测试用 Mentor 与 INACTIVE 凭据已停用。

## 认证行为

- 服务端检查 `ADMIN + ACTIVE + login_enabled=true` 后，再校验密码凭据；MENTOR、INACTIVE、未启用账号统一拒绝。
- 使用 Node `scrypt`；密码不进入源码、Git、前端 bundle、localStorage、Debug 或日志。
- 登录失败对外统一为认证失败；按 `phone + IP` 做服务端内存限流，15 分钟最多 5 次，持久化限流列为后续技术债。
- Session 使用 `ASVA_AUTH_SECRET` HMAC 签名，8 小时过期，包含认证版本；改密、重置、停用凭据会递增版本并使旧 Session 失效。
- `scripts/set-initial-password.mjs` 使用隐藏终端输入；当前集成测试密码均为进程内随机值，不在报告中输出。

## 真实集成验证

在不改变 CloudBase Production `AUTH_MODE` 的前提下，使用进程级 `AUTH_MODE=PASSWORD` 连接真实 Feishu Production Staff 与认证表完成：

- 正确密码、错误密码、固定 `888888`、未知手机号：PASS
- MENTOR 禁止登录、INACTIVE 禁止登录：PASS
- 首次改密、旧密码失效、新密码生效：PASS
- 改密后旧 Session 失效：PASS
- 管理员重置密码、强制下次改密、旧密码失效：PASS
- Mentor 手机号同步到认证表、测试凭据停用：PASS
- 管理员最终凭据：`ACTIVE`，`must_change_password=true`，使用 `scrypt`

## 回归与质量检查

- AuthCredential Schema Check：PASS；缺失、额外字段、类型不匹配均为 0
- Customer Schema / Stage 1 Schema Check：PASS
- Customer Data Check：PASS；14 Customers、9 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments，数据质量问题均为 0
- `npm run typecheck`：PASS
- `npm test`：PASS，128/128
- CloudBase function build：PASS；未部署

## 当前阻塞与下一步边界

1. R002 前需要由授权操作者通过隐藏输入 CLI 设置可交付给管理员本人的首次密码；本报告不保存也不回显该密码。
2. 单独授权 R002 时，才可切换 Production 到 `AUTH_MODE=PASSWORD`，完成 CloudBase Backend、Frontend 和浏览器人工验收。
3. 浏览器点击级人工验收仍为 BLOCKED；因此 `STAGE1_CODE_READY_FOR_PRODUCTION` 保持 NO。

本阶段不执行 `release:prepare`、Production merge、Pages deploy、CloudBase deploy 或 Stage 2。

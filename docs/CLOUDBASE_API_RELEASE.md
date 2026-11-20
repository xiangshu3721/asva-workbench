# ASVA CloudBase API 发布

`asva-api` 生产发布使用 CloudBase **环境级 API Key** 和 GitHub Actions Environment Secret。它不依赖开发机或 Codex 的 `tcb login` 缓存，也不使用 OIDC、STS 或 CAM 角色。

此凭据只能操作创建它的 CloudBase 环境；它不是腾讯云账号级 `SecretId`/`SecretKey`，也不能放入前端、代码库或日志。CloudBase 官方 CLI 支持的非交互登录命令是：

```bash
tcb login --cloudbase-api-key <key> -e <envId>
```

工作流固定使用 `@cloudbase/cli@3.8.1`、环境 `root-journey-prod-d4d7pzd0a8f805` 与函数 `asva-api`。

## 一次性管理员配置

1. 在 CloudBase 生产环境的 **环境设置 → API Key** 中创建一个服务器端环境 API Key，例如 `github-asva-api-release`。不要使用 `publish_key`。保存创建时仅显示一次的明文值。
2. 在 GitHub 仓库创建受保护 Environment：`cloudbase-production`。将部署分支限制为 `master`，并按现有发布治理配置审批人。
3. 仅在该 GitHub Environment 中创建 Secret：`CLOUDBASE_API_KEY`，值为步骤 1 的 API Key。不要添加 `SecretId`、`SecretKey`、OIDC 变量、登录缓存或生产环境变量。
4. 先在 Actions 手动运行 **Release ASVA API (manual)**，选择 `verify`。它应能完成函数详情读取、远端代码哈希读取、`$LATEST` 代码下载、回滚包清单校验与健康检查（要求 `{ "ok": true }`）。

若 `verify` 因权限不足失败，停止发布；不要退回到账号级密钥、OIDC 或本机登录。环境级 API Key 是 CloudBase 官方提供的单环境凭据，但实际 `UpdateFunctionCode` 权限只能在获准的真实 `deploy` 中由 CLI 证实；`verify` 不会修改生产代码。

## 发布与回滚边界

在 `verify` 完成且获得发布授权后，手动运行同一工作流，选择 `deploy` 并输入 `DEPLOY_ASVA_API`。工作流会：

1. 再次建立并验证 `asva-api` 的 `$LATEST` 回滚基线；
2. 仅执行 `tcb fn code update asva-api --deployMode cos`；
3. 用健康端点确认 `{ "ok": true }`；
4. 若部署结果或健康检查不能确认，使用已验证的本次备份回滚，并校验远端代码哈希是否回到基线；
5. 若上传、回滚或哈希任一结果无法确认，工作流失败并报告“状态未知”，不会伪报发布成功。

工作流不运行 `npm run deploy:cloudbase:all`，不部署 `asva-ai-archive`、Worker、触发器或 HTTP 路由，不更新函数环境变量，也不读写飞书数据。

## 当前验证状态

仓库已离线验证固定 CLI 命令参数、API-only 命令范围、代码下载产物清单/哈希、失败回滚与健康检查逻辑。当前 GitHub 仓库尚未配置 `cloudbase-production` Environment，且本地没有该生产 API Key，因此尚未完成真实 API Key 的 CloudBase 读取验证，也没有部署生产。完成上述一次性配置后，必须先运行 `verify`；只有读取、回滚基线和健康检查全都通过，才可认为该发布链路就绪。

## 安全保存版（PR #117）发布顺序

此版本只恢复资料保存，不启用任何 AI 整理。发布前由有生产权限的审批人逐项回读以下运行时开关，均须为关闭态：

- `FEATURE_AUTOMATIC_PROFILE_ARCHIVING=false`
- `FEATURE_AUTOMATIC_PROFILE_ARCHIVING_MODE=off`
- `FEATURE_AUTOMATIC_PROFILE_ARCHIVING_CANARY=false`
- `FEATURE_ON_DEMAND_AI_PROCESSING=false`
- `FEATURE_ON_DEMAND_AI_AUTO_TRIGGER=false`
- `ON_DEMAND_AI_DAILY_LIMIT=0`

合并到 `master` 会自动触发 `Deploy ASVA Workbench to GitHub Pages`，因此不能把合并说成“没有生产发布”。该 Pages 发布仅更新前端；本版本在两个按需 AI 开关都关闭时不会发出 AI 整理请求，资料保存后显示“资料已保存，AI 整理暂未开启”。

CloudBase API 不会随合并自动发布。Pages 成功后，仍须在受保护的 `cloudbase-production` Environment 中按以下顺序人工运行 `Release ASVA API (manual)`：

1. 先以 `verify` 读取并验证现有 `asva-api`、回滚基线和健康检查；失败即停止。
2. 确认本次 `master` SHA 与已审查的 PR 合并 SHA 一致，并保留上述关闭态配置与 `asva-ai-archive` 的暂停 Cron。
3. 获得生产审批后，以 `deploy` 和确认文本 `DEPLOY_ASVA_API` 发布 **asva-api 代码**；它不会发布 Worker、恢复 Cron、变更触发器或环境变量。
4. 回读 `/asva-api/api/health` 的 HTTP 200 / `ok:true` 及 feature flags，确认 AI 开关仍为关闭态；只做已有资料的只读验收，不调用资料整理接口。

若任一配置无法安全回读，或 API 健康检查失败，停止在该步骤，不以 Pages 已发布替代 API 验收，也不通过重启 Worker、开启 Cron 或调用模型来排障。

## 持久化额度守门（PR #119）

PR #119 仅为**手动单条整理**增加跨实例额度守门；保存后自动整理仍由代码硬性拒绝。标准 API-only 工作流只更新 `asva-api` 代码并保留现有函数环境变量，不能借由代码发布改变以下配置。

在获得单独的生产配置授权、且完成只读事务能力核对前，保持：

- `FEATURE_ON_DEMAND_AI_PROCESSING=false`
- `FEATURE_ON_DEMAND_AI_AUTO_TRIGGER=false`
- `ON_DEMAND_AI_DAILY_LIMIT=0`
- `ON_DEMAND_AI_BUDGET_COLLECTION=`（空）

获批恢复手动整理时，先为额度守门创建并只供其使用的 CloudBase NoSQL 集合，再通过受控生产配置一次性设置：

- `FEATURE_ON_DEMAND_AI_PROCESSING=true`
- `FEATURE_ON_DEMAND_AI_AUTO_TRIGGER=false`
- `ON_DEMAND_AI_DAILY_LIMIT=<获批的 1–100 整数>`
- `ON_DEMAND_AI_BUDGET_COLLECTION=<专用集合名>`
- `ON_DEMAND_AI_MAX_CONCURRENT=1`

配置后先回读健康检查中的开关与“预算存储已配置”状态，再由管理员将持久化控制状态从默认 `DISABLED` 切到 `ENABLED`，仅对一笔事先授权的资料执行一次手动整理。若事务、最终状态记录或结果回读任一步无法确认，立即切换为 `PAUSED`；不得重试、重投、开启自动触发、恢复 Worker 或修改 Cron。

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

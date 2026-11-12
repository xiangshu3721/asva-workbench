# ASVA CloudBase API 发布

`asva-api` 生产发布使用 GitHub Actions 的 OIDC 临时凭据。它不依赖开发机或 Codex 的 `tcb login` 缓存，也不保存腾讯云长期密钥。

## 一次性管理员配置

在腾讯云 CAM 中创建 OIDC 身份提供商和角色。身份提供商使用 GitHub Actions：

- IdP URL：`https://token.actions.githubusercontent.com`
- Client ID：`sts.tencentcloudapi.com`
- 签名公钥：GitHub Actions OIDC JWKS 中的当前公钥

角色的信任策略必须同时限制：

- `oidc:iss` 为上述 GitHub IdP URL；
- `oidc:aud` 为 `sts.tencentcloudapi.com`；
- `oidc:sub` 为 `repo:xiangshu3721/asva-workbench:environment:cloudbase-production`。

本工作流使用 GitHub Environment，因此 GitHub 会签发上述 Environment subject；在该 Environment 中再将部署分支限制为 `master`，并配置审批人。工作流本身也会拒绝非 `master` 的运行。

固定使用的 CloudBase CLI `3.8.1` 实际通过 SCF API 执行这些命令：

- `tcb fn detail`：`scf:GetFunction`
- `tcb fn code download`：`scf:GetFunctionAddress`
- `tcb fn code update --deployMode cos`：`scf:GetFunction`、`scf:GetTempCosInfo`、`scf:UpdateFunctionCode`
- 回滚前后远端代码哈希：同样通过 `tcb api scf GetFunctionAddress` 读取 `CodeSha256`

因此角色只需要以下四项 SCF action：

- `scf:GetFunction`
- `scf:GetFunctionAddress`
- `scf:GetTempCosInfo`
- `scf:UpdateFunctionCode`

`GetTempCosInfo` 只取得一次性上传凭据，不等同于授予持久 COS 读写权限。

不要授予 `UpdateFunctionConfiguration`、触发器、路由、数据库、飞书或 Worker 权限。当前腾讯云 SCF CAM 表将上述更新 action 标为操作级权限，不能可靠限制到单个函数 ARN；因此策略只能收窄到这四个 action，`asva-api` 的单函数边界由工作流固定目标、`master` 限制及 Environment 审批共同强制。若需要 CAM 层的单函数物理隔离，应使用独立腾讯云账号/环境，而不是扩张该角色权限。

在 GitHub 仓库创建受保护 Environment：`cloudbase-production`，设置审批人，并将部署分支限制为 `master`。为该 Environment 添加两个非敏感 Variables：

- `ASVA_TENCENT_CLOUD_OIDC_PROVIDER_ID`
- `ASVA_TENCENT_CLOUD_ROLE_ARN`

不需要 GitHub Secrets；不得添加 `SecretId`、`SecretKey`、CloudBase 登录缓存或生产环境变量。

CAM 的 OIDC 配置保存的是 GitHub JWKS 公钥集；GitHub 轮换签名密钥时，需要由腾讯云账号管理员按 CAM 的 OIDC 配置更新公钥。工作流会安全失败，不会退回到本机登录或未受限的长期密钥。

自定义策略模板（将 `<UIN>` 替换为腾讯云账号 UIN）如下：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": [
        "name/scf:GetFunction",
        "name/scf:GetFunctionAddress",
        "name/scf:GetTempCosInfo",
        "name/scf:UpdateFunctionCode"
      ],
      "resource": "*"
    }
  ]
}
```

`<UIN>` 不需要写入这个操作级策略；保留在角色 ARN 中即可。不要把此限制误报为函数级资源限制。

## 运行方式

在 Actions 中手动运行 **Release ASVA API (manual)**，且只能从 `master` 运行：

1. 先选择 `verify`。它只交换临时身份、检查 `asva-api`、读取远端 `CodeSha256`、下载并验证 `$LATEST` 的可部署代码目录及内容清单、并访问健康端点（要求 `{ "ok": true }`）。
2. 通过后，如已获发布授权，选择 `deploy` 并输入 `DEPLOY_ASVA_API`。工作流只执行 `tcb fn code update asva-api`。

部署前会重新核验远端 `CodeSha256`，避免覆盖基线建立后发生的外部变更；部署后健康检查失败会立刻用本次下载的 `asva-api` 代码回滚，并再次核验远端哈希已回到基线。若上传结果、回滚结果或哈希任一项无法确认，工作流会失败并明确报告“状态未知”。

本工作流不执行 `npm run deploy:cloudbase:all`，不部署 `asva-ai-archive`，不创建触发器或 HTTP 路由，也不写入函数环境变量。

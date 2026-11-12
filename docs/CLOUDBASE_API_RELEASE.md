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

该角色只需要下列 CloudBase 权限，资源限定为生产环境 `root-journey-prod-d4d7pzd0a8f805`：

- `tcb:GetFunction`
- `tcb:DownloadFunction`
- `tcb:UpdateFunctionCode`

`tcb fn code update --deployMode cos` 还可能需要同一环境范围内的 `tcb:GetTempCosInfo`，以取得一次性的上传凭据；它不等同于授予持久 COS 读写权限。首次 `verify` 不会调用该权限，首次 `deploy` 如明确报此 action 缺失，再仅添加它。

不要授予 `UpdateFunctionConfiguration`、触发器、路由、数据库、飞书或 Worker 权限。由于 CLI 的底层实现可能额外请求只读元数据，第一次 `verify` 如果返回明确的 CAM 缺失 action，只补充该只读 action，不授予全量预设策略。

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
        "name/tcb:GetFunction",
        "name/tcb:DownloadFunction",
        "name/tcb:UpdateFunctionCode"
      ],
      "resource": [
        "qcs::tcb:ap-shanghai:uin/<UIN>:env/root-journey-prod-d4d7pzd0a8f805"
      ]
    }
  ]
}
```

## 运行方式

在 Actions 中手动运行 **Release ASVA API (manual)**，且只能从 `master` 运行：

1. 先选择 `verify`。它只交换临时身份、检查 `asva-api`、下载当前代码作为本次运行的回滚基线，并访问健康端点。
2. 通过后，如已获发布授权，选择 `deploy` 并输入 `DEPLOY_ASVA_API`。工作流只执行 `tcb fn code update asva-api`。

部署前会重新核验代码哈希，避免覆盖基线建立后发生的外部变更；部署后健康检查失败会立刻用本次下载的 `asva-api` 代码回滚。若回滚结果无法确认，工作流会失败并明确报告“状态未知”。

本工作流不执行 `npm run deploy:cloudbase:all`，不部署 `asva-ai-archive`，不创建触发器或 HTTP 路由，也不写入函数环境变量。

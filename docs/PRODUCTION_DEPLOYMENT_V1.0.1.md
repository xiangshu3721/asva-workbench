# ASVA V1.0.1 生产部署文档

## 部署概述

本次部署成功将 ASVA 心理测评系统从 v41 升级到 V1.0.1（commit 8aa2ec1），包含以下核心变更：
- 分享链接加密存储（pgcrypto）
- 报告更新历史记录（SUPERSEDED 状态）
- 新增 4 个 V1.0.1 接口

## 环境信息

- **CloudBase 环境**: root-journey-prod-d4d7pzd0a8f805
- **函数名称**: asva-api
- **数据库**: pgdb-d9ebsg2h
- **HTTP 网关**: /asva-api
- **部署时间**: 2026-11-26

## 关键工具和版本

### CloudBase CLI

**重要**: 必须使用新版 CLI 才能正确切换 HTTP 网关路由版本绑定。

```bash
# 新版 CLI 路径（3.9.4+）
/tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb

# 验证版本
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb --version
# 预期输出: CloudBase CLI 3.9.4 或更高
```

**注意**: 旧版 CLI（3.8.1）的 `routes edit` 命令不支持 `upstreamResourceVersion` 参数，会导致路由切换失败。

## 部署步骤

### 1. 数据库迁移

```bash
# 执行 V1.0.1 迁移脚本
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "$(cat cloudbase/migrations/20261125200000_asva_assessment_ux_optimization.sql)" \
  --json
```

**验证迁移**:
```bash
# 检查新增列
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'asva_assessment_bindings' AND column_name = 'encrypted_share_url'" \
  --json

# 检查新约束
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "SELECT conname FROM pg_constraint WHERE conrelid = 'asva_assessment_bindings'::regclass AND conname LIKE '%status_check'" \
  --json
```

### 2. 配置加密密钥

**创建配置表**:
```bash
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "
CREATE TABLE IF NOT EXISTS public.asva_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
" --json
```

**生成并存储加密密钥**:
```bash
# 生成 32 字节随机密钥
ENCRYPTION_KEY=$(openssl rand -hex 32)
echo "加密密钥: $ENCRYPTION_KEY"

# 存储到配置表
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "INSERT INTO public.asva_config (key, value) VALUES ('encryption_key', '$ENCRYPTION_KEY') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP" \
  --json
```

**验证密钥存储**:
```bash
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "SELECT key, LEFT(value, 16) || '...' as value_preview FROM public.asva_config WHERE key = 'encryption_key'" \
  --json
```

### 3. 测试加密解密闭环

```bash
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "
SET asva.encryption_key = 'aceca5f5030246cda809c80f3b25545e94bcfb9b24567f7bbfd910680355ed43';
SELECT 
  pgp_sym_encrypt('https://example.mindtest.com/report/abc123?token=xyz789', current_setting('asva.encryption_key')) as encrypted,
  pgp_sym_decrypt(
    pgp_sym_encrypt('https://example.mindtest.com/report/abc123?token=xyz789', current_setting('asva.encryption_key')),
    current_setting('asva.encryption_key')
  ) as decrypted;
" --json
```

**预期结果**: `decrypted` 字段应返回原始 URL。

### 4. 部署后端代码

```bash
# 构建函数代码
npm run build:cloudbase

# 部署到 CloudBase
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb fn code update \
  asva-api \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --dir cloudbase/functions/asva-api \
  --json
```

### 5. 发布新版本

```bash
# 发布新版本（自动递增版本号）
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb fn publish-version \
  asva-api \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --description "V1.0.1 UX Optimization - 8aa2ec1" \
  --json
```

**记录新版本号**: 从输出中提取版本号（例如：42, 43 等）。

### 6. 切换 HTTP 网关路由（关键步骤）

**重要**: 必须使用新版 CLI（3.9.4+），否则 `upstreamResourceVersion` 参数不会生效。

```bash
# 查看当前路由配置
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb routes list \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --json | grep -B 5 -A 10 "asva-api"

# 切换到新版本（替换 NEW_VERSION 为实际版本号）
echo "Y" | node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb routes edit \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --data '{"domain":"*","routes":[{"path":"/asva-api","upstreamResourceVersion":"NEW_VERSION"}]}' \
  --json
```

**验证路由切换**:
```bash
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb routes list \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --json | grep -B 5 -A 10 "asva-api"
```

**预期结果**: `UpstreamResourceVersion` 应为新版本号。

### 7. 验证部署

#### 7.1 检查 Health 端点

```bash
curl -s https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/health | jq .
```

**预期结果**:
```json
{
  "ok": true,
  "gitCommit": "8aa2ec13c5997f081077eb97f83d1dc9d5629c57",
  "release": "R048.17",
  ...
}
```

#### 7.2 测试 V1.0.1 新接口

```bash
# 测试更新历史接口（应返回 AUTH_REQUIRED，而非 NOT_FOUND）
curl -s https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/assessments/bindings/test-id/update-history | jq .

# 预期输出:
# {
#   "success": false,
#   "code": "AUTH_REQUIRED",
#   "message": "请先登录",
#   ...
# }
```

#### 7.3 测试加密分享链接

```bash
# 补充分享链接（需要有效的 bindingId）
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "
SET asva.encryption_key = 'aceca5f5030246cda809c80f3b25545e94bcfb9b24567f7bbfd910680355ed43';
SELECT public.asva_assessment_guard(jsonb_build_object(
  'action', 'supplement_share_url',
  'bindingId', 'ABD-B5D288C6BD5343ACAB',
  'shareUrl', 'https://report.mindtest.com/view#rpt_-2vHQjKVgYE.secrettoken123'
));
" --json

# 获取分享链接
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "
SET asva.encryption_key = 'aceca5f5030246cda809c80f3b25545e94bcfb9b24567f7bbfd910680355ed43';
SELECT public.asva_assessment_guard(jsonb_build_object(
  'action', 'get_share_url',
  'bindingId', 'ABD-B5D288C6BD5343ACAB'
));
" --json
```

**预期结果**: 返回的 `shareUrl` 应与补充时一致。

## 已知问题和限制

### 1. 自定义 PostgreSQL 参数权限

**问题**: CloudBase PostgreSQL 不允许通过 `ALTER DATABASE SET` 设置自定义参数（如 `asva.encryption_key`）。

**错误信息**:
```
ERROR: permission denied to set parameter "asva.encryption_key" (SQLSTATE 42501)
```

**解决方案**: 
- 使用 `asva_config` 配置表存储加密密钥
- 在会话级别使用 `SET asva.encryption_key = '...'` 临时设置
- 修改函数代码从配置表读取密钥（需要代码变更）

**当前状态**: 迁移脚本使用 `current_setting('asva.encryption_key', true)`，需要在每次 RPC 调用前设置会话参数。这在实际应用中需要额外的中间件支持。

### 2. HTTP 网关路由版本绑定

**问题**: 旧版 CLI（3.8.1）的 `routes edit` 命令不支持 `upstreamResourceVersion` 参数，导致无法切换 HTTP 网关的版本绑定。

**解决方案**: 必须使用新版 CLI（3.9.4+）执行路由切换。

**验证方法**:
```bash
# 使用新版 CLI 查看路由
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb routes list \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --json | grep -A 10 "asva-api"

# 确认 UpstreamResourceVersion 字段存在且正确
```

## 回滚计划

### 场景 1: 代码回滚

```bash
# 1. 查看可用版本
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb fn list-function-versions \
  asva-api \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --json

# 2. 切换 HTTP 网关到旧版本（例如 v41）
echo "Y" | node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb routes edit \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --data '{"domain":"*","routes":[{"path":"/asva-api","upstreamResourceVersion":"41"}]}' \
  --json

# 3. 验证回滚
curl -s https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/health | jq .gitCommit
# 应返回旧版本的 commit hash
```

### 场景 2: 数据库回滚

**警告**: 数据库回滚会丢失 V1.0.1 的所有数据变更。

```bash
# 1. 删除新增列
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "ALTER TABLE public.asva_assessment_bindings DROP COLUMN IF EXISTS encrypted_share_url" \
  --json

# 2. 恢复旧约束
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "$(cat cloudbase/migrations/20261124180000_asva_assessment_bindings.sql)" \
  --json

# 3. 删除配置表（可选）
node /tmp/tcb-new/node_modules/@cloudbase/cli/bin/tcb db execute \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --sql "DROP TABLE IF EXISTS public.asva_config" \
  --json
```

## 部署检查清单

- [ ] 数据库迁移执行成功
- [ ] 加密密钥已生成并存储
- [ ] 加密解密闭环测试通过
- [ ] 后端代码部署成功
- [ ] 新版本已发布
- [ ] HTTP 网关路由已切换到新版本（使用新版 CLI）
- [ ] Health 端点返回正确的 commit hash
- [ ] V1.0.1 新接口可访问（返回 AUTH_REQUIRED 而非 NOT_FOUND）
- [ ] 分享链接加密存储和解密 retrieval 工作正常

## 相关文件

- **迁移脚本**: `cloudbase/migrations/20261125200000_asva_assessment_ux_optimization.sql`
- **部署配置**: `.deploy-production.env`
- **构建脚本**: `scripts/build-cloudbase-function.mjs`
- **HTTP 网关配置**: CloudBase 控制台 → 环境 → 域名和路由

## 联系人

如有部署问题，请联系开发团队。

---

**文档版本**: 1.0  
**最后更新**: 2026-11-26  
**部署执行者**: AI Assistant  
**审核状态**: 待审核

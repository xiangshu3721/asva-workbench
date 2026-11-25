# Assessment Stage 2 — Controlled Production Release Plan

> 受控生产发布流程。本文档定义迁移顺序、环境变量、验证清单和回滚步骤。
>
> **本文档是 `05-E2E-ACCEPTANCE-PLAN.md` 的前置步骤。**

---

## 1. 发布概述

| 项目 | 说明 |
|---|---|
| PR | #124 `assessment/stage2-import` |
| 目标分支 | `master`（非 main） |
| 变更范围 | server/index.mjs, src/App.tsx, assessment-pg-store.mjs, assessment-pg-test-store.mjs |
| 数据库变更 | 新建表 `asva_assessment_bindings`, `asva_assessment_events`; 新建 RPC `asva_assessment_guard` |
| 外部依赖 | CloudBase PostgreSQL (via RPC gateway) |
| 部署方式 | GitHub Actions → CloudBase SCF + Pages（受控发布，非自动） |
| 回滚策略 | 代码回退 + 数据保留 |

---

## 2. 发布前检查

### 2.1 确认 master 最新版本

```bash
git fetch origin
git log origin/master --oneline -5
# 记录当前版本，避免覆盖其他已上线修改
```

### 2.2 记录生产 v37 回滚点

```bash
# 记录当前生产版本的 commit
git log origin/master -1 --format="%H %s" > rollback-point.txt

# 记录当前 SCF 版本（如果有版本标识）
# 记录当前 Pages 部署版本
```

### 2.3 确认无未合并的紧急修复

```bash
# 检查是否有其他分支需要优先合并
git branch -r | grep -v master | grep -v assessment
```

---

## 3. 迁移顺序（严格按此顺序）

### Phase 1: 数据库迁移

```bash
# 1. 备份当前数据库（CloudBase 控制台导出）
# 2. 执行迁移 SQL（使用生产数据库连接）
psql -h <prod-host> -U <prod-user> -d <prod-db> \
  -f cloudbase/migrations/20261124180000_asva_assessment_bindings.sql

# 3. 验证迁移
psql -h <prod-host> -U <prod-user> -d <prod-db> -c "
  SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('asva_assessment_bindings', 'asva_assessment_events');
"
# 预期输出：2 行

psql -h <prod-host> -U <prod-user> -d <prod-db> -c "
  SELECT routine_name FROM information_schema.routines
  WHERE routine_name = 'asva_assessment_guard';
"
# 预期输出：1 行
```

### Phase 2: 环境变量配置

在 CloudBase 控制台设置（不覆盖现有变量）：

```bash
# 必填：CloudBase API Key（用于 RPC 认证）
# 注意：复用现有 CLOUDBASE_APIKEY，不要覆盖
CLOUDBASE_APIKEY=<existing-key>

# 必填：CloudBase 环境 ID（用于构建 RPC URL）
# 注意：复用现有 TCB_ENV，不要覆盖
TCB_ENV=<existing-env-id>

# 可选：覆盖 RPC 基础 URL（通常不需要，会自动从 TCB_ENV 构建）
# ASSESSMENT_RPC_BASE_URL=https://<env-id>.api.tcloudbasegateway.com/v1/rdb/rest/rpc

# 可选：覆盖 RPC 函数名（默认 asva_assessment_guard）
# ASSESSMENT_RPC_FUNCTION=asva_assessment_guard
```

**重要**：仅新增评估相关变量，不修改现有的 DeepSeek、飞书、额度守门等配置。

### Phase 3: 代码合并与部署

```bash
# 1. 合并 PR #124 到 master
git checkout master
git pull origin master
git merge --no-ff assessment/stage2-import -m "feat(assessment): customer binding + snapshot storage"
git push origin master

# 2. 触发 CloudBase SCF 部署（通过 GitHub Actions 或手动）
# 方式 A：等待 GitHub Actions 自动部署（如果配置了）
# 方式 B：手动触发 CloudBase CLI 部署
npm run deploy:cloudbase

# 3. 等待部署完成（约 2-5 分钟）
```

### Phase 4: 冒烟验证

```bash
# 4a. 健康检查
curl -s https://<production>/api/health | jq .
# 预期：200, version 包含最新 commit

# 4b. 前端页面加载
# 打开浏览器访问 https://<production>/
# 使用飞书登录，验证页面正常显示

# 4c. 评估导入冒烟（通过前端 UI）
# 1. 登录工作台
# 2. 选择一个客户
# 3. 点击"导入测评报告"
# 4. 粘贴测试分享链接
# 5. 确认预览正常，无凭证泄露

# 4d. 评估绑定冒烟（通过前端 UI）
# 1. 确认绑定成功
# 2. 检查绑定列表显示
# 3. 点击查看快照，确认显示正常

# 4e. 验证快照存储（通过浏览器开发者工具）
# Network tab → 找到 snapshot API 请求
# 检查响应：sourceStatus = "UNKNOWN"
```

---

## 3. CloudBase RPC 合约验证

**关键**：生产环境使用 CloudBase REST RPC 网关，非直接 PostgreSQL 连接。

### RPC 请求格式

```
POST https://<env-id>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/asva_assessment_guard
Authorization: Bearer <CLOUDBASE_APIKEY>
Content-Type: application/json

{
  "request": {
    "action": "bind",
    "table": "asva_assessment_bindings",
    "bindingId": "ABD-...",
    "provider": "mindtest-web",
    "reportId": "...",
    "customerId": "...",
    ...
  }
}
```

### RPC 响应格式

```json
// 成功
{
  "data": {
    "idempotent": false,
    "binding": { "id": "ABD-...", "status": "ACTIVE", ... }
  }
}

// 业务错误（由 RPC 函数返回）
{
  "data": {
    "error": {
      "code": "REPORT_ALREADY_BOUND",
      "message": "此报告已绑定到其他客户",
      "status": 409
    }
  }
}

// 网关/系统错误
{
  "error": {
    "message": "...",
    "code": "...",
    "status": 503
  }
}
```

### 验证步骤

```bash
# 直接用 curl 测试 RPC 合约
curl -X POST \
  "https://<env-id>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/asva_assessment_guard" \
  -H "Authorization: Bearer $CLOUDBASE_APIKEY" \
  -H "Content-Type: application/json" \
  -d '{
    "request": {
      "action": "get",
      "table": "asva_assessment_bindings",
      "customerId": "<test-customer-id>"
    }
  }'
# 预期：200, data.bindings 为数组
```

**如果 RPC 返回 404 或 401**：
1. 检查 `CLOUDBASE_APIKEY` 是否正确
2. 检查 `TCB_ENV` / RPC URL 是否正确
3. 确认 `asva_assessment_guard` 函数已创建
4. 确认 `service_role` 有 EXECUTE 权限

---

## 4. 发布验证清单

### 4.1 数据库验证

- [ ] `asva_assessment_bindings` 表存在
- [ ] `asva_assessment_events` 表存在
- [ ] `asva_assessment_guard` 函数存在
- [ ] 部分唯一索引 `asva_assessment_bindings_unique_active_idx` 存在
- [ ] RLS 策略已启用（service_role 无法直接访问表）

### 4.2 API 验证

- [ ] `POST /api/assessments/import` 返回预览（无凭证泄露）
- [ ] `POST /api/customers/:id/assessments/confirm` 返回绑定（archiveAuthorized=true, customerConsent=false）
- [ ] `GET /api/customers/:id/assessments` 返回活跃绑定列表
- [ ] `GET /api/customers/:id/assessments/history` 返回所有状态历史
- [ ] `GET /api/assessments/bindings/:id/snapshot` 返回快照（sourceStatus=UNKNOWN）
- [ ] 非活跃绑定的快照：管理员 200，非管理员 403 BINDING_NOT_ACTIVE
- [ ] 无 AI 授权时非管理员快照：403 AI_CONSENT_REQUIRED
- [ ] `POST /api/assessments/bindings/:id/consent` 授权成功
- [ ] `POST /api/assessments/bindings/:id/unbind` 解绑成功（仅管理员）
- [ ] `POST /api/assessments/bindings/:id/transfer` 转移成功（仅管理员）
- [ ] `POST /api/assessments/bindings/:id/revoke` 撤销成功（仅管理员）
- [ ] `GET /api/assessments/bindings/:id/events` 返回审计事件

### 4.3 前端验证

- [ ] 评估面板显示绑定列表
- [ ] 快照查看器可以打开并显示数据
- [ ] 快照查看器显示源状态（未知/已撤销）
- [ ] 快照查看器显示 AI 授权状态
- [ ] 管理员可以看到转移/解绑/撤销按钮
- [ ] 非管理员看不到管理操作按钮

### 4.4 安全验证

- [ ] linkSecret 不出现在任何 API 响应中
- [ ] ownerToken 不出现在任何 API 响应中
- [ ] 存储的 snapshot 字段不包含 linkSecret/ownerToken
- [ ] 存储的 shareUrl 不包含 linkSecret（fragment 中 `.` 后部分已剥离）

---

## 5. 回滚程序

### 5.1 回滚触发条件

| 严重程度 | 条件 | 动作 |
|---|---|---|
| P0 — 立即回滚 | 凭证泄露（linkSecret 出现在响应中） | 立即回滚 |
| P0 — 立即回滚 | 非管理员可访问其他客户的快照 | 立即回滚 |
| P1 — 30分钟内回滚 | RPC 持续 503（存储服务不可用） | 回滚代码，保留数据 |
| P1 — 30分钟内回滚 | 同一报告出现多个 ACTIVE 绑定 | 回滚代码，手动修复数据 |
| P2 — 下个版本修复 | 源状态显示不正确 | 记录问题，下个版本修复 |
| P2 — 下个版本修复 | 前端显示异常 | 记录问题，下个版本修复 |

### 5.2 回滚步骤

```bash
# Step 1: 回退代码
git checkout master
git pull origin master
git revert <assessment-merge-commit> --no-edit
git push origin master

# Step 2: 触发 CloudBase SCF 部署
# 方式 A：等待 GitHub Actions 自动部署
# 方式 B：手动触发
npm run deploy:cloudbase

# Step 3: 验证回滚
curl -s https://<production>/api/health | jq .version

# Step 4: 数据清理（可选）
# 评估绑定数据可以保留，不影响旧版本运行
# 如需清理：
# psql -c "DELETE FROM public.asva_assessment_events;"
# psql -c "DELETE FROM public.asva_assessment_bindings;"
# 注意：表结构和 RPC 函数保留，不影响旧版本（旧版本不使用这些表）
```

### 5.3 数据保留策略

**回滚后不需要删除数据**：
- 旧版本代码不使用 `asva_assessment_bindings` / `asva_assessment_events` 表
- 数据保留可以在重新部署时恢复
- 如需重新部署，直接执行 Phase 3 即可

---

## 6. 监控

### 6.1 关键指标

| 指标 | 来源 | 告警阈值 |
|---|---|---|
| 评估 API 错误率 | 服务器日志 `ASVA_API_ERROR` | > 5% 的评估请求 |
| RPC 延迟 | 服务器日志 `duration` 字段 | P99 > 5s |
| RPC 503 率 | `ASSESSMENT_STORE_UNAVAILABLE` 错误 | > 1% |
| 绑定数量 | `SELECT COUNT(*) FROM asva_assessment_bindings` | 持续增长 |

### 6.2 日志关键字

```bash
# 评估相关错误
grep 'ASSESSMENT_STORE_UNAVAILABLE' logs
grep 'ASSESSMENT_BIND_INVALID' logs
grep 'REPORT_ALREADY_BOUND' logs
grep 'BINDING_NOT_ACTIVE' logs
grep 'AI_CONSENT_REQUIRED' logs

# RPC 相关
grep 'asva_assessment_guard' logs
```

---

## 7. 发布后检查

发布后 24 小时内完成以下检查：

- [ ] 至少成功导入 1 份真实报告
- [ ] 快照数据完整（包含维度、标签等）
- [ ] 凭证未泄露（检查 snapshot 字段）
- [ ] 源状态显示为 UNKNOWN
- [ ] 审计事件已记录
- [ ] 无 P0/P1 问题

---

## 8. 联系信息

| 角色 | 人员 | 联系方式 |
|---|---|---|
| 开发负责人 | ... | ... |
| 运维负责人 | ... | ... |
| 产品负责人 | ... | ... |

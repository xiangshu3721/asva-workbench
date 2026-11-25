# Assessment Stage 2 — Real E2E Acceptance Plan

> 使用真实客户星报完成端到端验收。本文档定义验收步骤、观察指标和回滚条件。
> 
> **前置条件**：PR #124 已合并，生产环境已按 `06-RELEASE-PLAN.md` 部署。

---

## 1. 验收目标

| 目标 | 验证方式 |
|---|---|
| 真实星报可以成功导入并绑定到客户 | 用真实分享链接执行 preview → confirm |
| 快照不可变存储 | 确认 snapshot 字段为绑定时读取的完整数据，无 linkSecret |
| 非活跃绑定不可被非管理员访问 | 解绑/撤销后，非管理员查看快照返回 403 |
| 源状态显示为"未知"而非"已验证" | 快照返回 `sourceStatus: 'UNKNOWN'` |
| AI 授权与归档授权分离 | 绑定时 archiveAuthorized=true, customerConsent=false |
| 审计事件完整 | BOUND 事件已记录 |

---

## 2. 验收环境

- **分支**：`assessment/stage2-import`（合并后为 `main`）
- **环境**：生产 CloudBase + 生产 PostgreSQL
- **测试客户**：选择一个已有客户（或创建测试客户）
- **测试报告**：用户自己的真实星报

---

## 3. 验收步骤

### Step 1: 准备

```bash
# 确认部署版本
curl -s https://<production>/api/health | jq .version

# 确认环境变量
# CLOUDBASE_APIKEY 已设置
# ASSESSMENT_RPC_BASE_URL 已设置（或 TCB_ENV 已设置）
```

### Step 2: Preview（预览不绑定）

```
POST /api/assessments/import
Body: { "shareUrl": "<真实星报分享链接>" }
```

**观察**：
- [ ] 返回 200，包含 `reportId`, `assessmentName`, `nickname`
- [ ] 响应中**不包含** `linkSecret`、`ownerToken`
- [ ] 分享链接 fragment 中 `.` 后的密钥部分未出现在响应中

### Step 3: Confirm（确认绑定）

```
POST /api/customers/<customerId>/assessments/confirm
Body: { "shareUrl": "<真实星报分享链接>" }
```

**观察**：
- [ ] 返回 201（首次）或 200（幂等重复）
- [ ] `bindingId` 非空
- [ ] `archiveAuthorized: true`
- [ ] `customerConsent: false`（AI 授权默认关闭）
- [ ] `preview.reportId` 与 Step 2 一致
- [ ] 响应中**不包含** linkSecret

### Step 4: 验证快照存储

```
GET /api/assessments/bindings/<bindingId>/snapshot
Headers: X-Staff-Id: <admin-id>
```

**观察**：
- [ ] 返回 200
- [ ] `sourceStatus: 'UNKNOWN'`（非 'OK'）
- [ ] `sourceStatusMessage` 包含"未知"
- [ ] `snapshot` 包含完整报告数据
- [ ] `snapshot.linkSecret` 不存在
- [ ] `snapshot.ownerToken` 不存在

### Step 5: 验证非活跃状态访问控制

```
# 5a: 管理员可以查看任何状态的快照
GET /api/assessments/bindings/<bindingId>/snapshot (Admin) → 200 ✓

# 5b: 解绑后，非管理员无法查看
POST /api/assessments/bindings/<bindingId>/unbind (Admin)
GET /api/assessments/bindings/<bindingId>/snapshot (非 Admin) → 403 BINDING_NOT_ACTIVE

# 5c: 重新绑定后可以查看
POST /api/customers/<customerId>/assessments/confirm (重新绑定)
GET /api/assessments/bindings/<newBindingId>/snapshot (非 Admin, 无 AI 授权) → 403 AI_CONSENT_REQUIRED

# 5d: 授予 AI 授权后可以查看
POST /api/assessments/bindings/<newBindingId>/consent
Body: { "action": "grant", "consentRecord": "客户口头同意" }
GET /api/assessments/bindings/<newBindingId>/snapshot (非 Admin) → 200 ✓
```

### Step 6: 审计事件

```
GET /api/assessments/bindings/<bindingId>/events (Admin)
```

**观察**：
- [ ] 包含 `BOUND` 事件
- [ ] 如执行了解绑，包含 `UNBOUND` 事件
- [ ] 如执行了授权，包含 `CONSENT_GRANTED` 事件

---

## 4. 验收通过标准

| 条件 | 必须 |
|---|---|
| Preview 不泄露凭证 | ✅ 必须 |
| Confirm 成功绑定 | ✅ 必须 |
| 快照完整且无凭证 | ✅ 必须 |
| sourceStatus = UNKNOWN | ✅ 必须 |
| 非活跃绑定访问控制生效 | ✅ 必须 |
| AI 授权独立控制 | ✅ 必须 |
| 审计事件完整 | ✅ 必须 |

---

## 5. 回滚条件

如出现以下情况，立即回滚：

1. **数据泄露**：linkSecret 或 ownerToken 出现在任何 API 响应中
2. **快照丢失**：绑定后 snapshot 字段为空
3. **权限穿透**：非管理员可查看非活跃绑定的快照
4. **RPC 失败**：所有评估操作返回 503（存储服务不可用）
5. **数据不一致**：同一报告出现多个 ACTIVE 绑定

---

## 6. 回滚步骤

```bash
# 1. 回退到上一个稳定版本
git revert <assessment-merge-commit>
git push origin main

# 2. CloudBase 自动部署（或手动触发）

# 3. 验证回滚
curl -s https://<production>/api/health | jq .version

# 4. 数据保留：评估绑定表数据不需要删除（仅代码回退）
#    如需清理：
#    DELETE FROM public.asva_assessment_bindings WHERE ...;
```

---

## 7. 验收报告模板

```
验收日期：
验收人：
环境版本：

Step 2 Preview：✅ / ❌
Step 3 Confirm：✅ / ❌
Step 4 快照存储：✅ / ❌
Step 5 访问控制：✅ / ❌
Step 6 审计事件：✅ / ❌

问题记录：
1. ...
2. ...

结论：通过 / 不通过
```

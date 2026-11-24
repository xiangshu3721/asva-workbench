# R048.17 生产基线文档

**创建日期：** 2026-11-24  
**状态：** ✅ 稳定基线，P0 修复结束  
**目的：** 固化自动归档、保存性能和费用安全机制，防止后续开发回归

---

## 1. 版本标识

| 项目 | 值 |
|------|-----|
| Git commit | `12aa238` |
| GitHub 分支 | `master` |
| 生产 SCF 版本 | v37 |
| 路由 | `/asva-api` → v37 |
| Release | R048.17 |
| 测试通过 | 906 个 |

---

## 2. 已恢复的业务功能

### 2.1 自动归档（Stage 4）

- 导师保存资料后，系统自动调用 DeepSeek 提取 Evidence
- Stage 4 批量写入正式字段 + 补充信息 + 回读验证
- 正式字段和补充信息均经过真实飞书写入验证

**关键规则（不得变更）：**
- 隐私保护、冲突检测、已确认事实保护、时间顺序规则
- Evidence → Customers 正式字段 → 补充信息写入链
- 回读验证通过后标记 COMPLETED
- 失败时标记 REVIEW_REQUIRED 或 FAILED

### 2.2 保存性能

| 指标 | 基线值 | 测试方法 |
|------|--------|---------|
| 保存接口响应时间 | ≤ 200ms | 生产日志 `POST /api/sources` 的 `timeCost` |
| AI 处理耗时 | 5-10 秒 | 生产日志 `ASVA_AUTO_TRIGGER` 耗时 |
| 端到端完成时间 | ≤ 30 秒 | Source 状态变为 COMPLETED |

### 2.3 费用安全约束

| 约束 | 值 | 实现位置 |
|------|-----|---------|
| 每日模型调用上限 | 100 | `HARD_DAILY_LIMIT`（代码硬编码） |
| 最大并发 | 2 | `HARD_MAX_CONCURRENT`（代码硬编码） |
| 幂等防重 | operationId 唯一 | PG `reserve` |
| 紧急暂停 | `setControl('DISABLED')` | PG 控制模式 |
| 暂停模式 | `setControl('PAUSED')` | PG 控制模式 |

---

## 3. 架构决策

### 3.1 异步 AUTO 触发

**选择：** Fire-and-forget Promise + SCF 事件循环保活

```
POST /api/sources → 飞书写入 → 201 响应
                        ↓
       processSourceOnDemand Promise 在事件循环中继续
```

**理由：**
- SCF Node.js 运行时保证事件循环清空前不终止
- 120s 超时内可完成（实测 5-10 秒）
- PG 幂等保底，超时不重复收费

**不选择：**
- 同步等待：保存耗时 7-39 秒，用户体验差
- Worker/Cron：属于旧架构，已废弃
- 消息队列：CloudBase 无原生支持

### 3.2 前端轮询策略

**选择：** 递增退避（5s, 10s, 15s, 20s, 25s, 30s，最多 6 次）

**理由：**
- 总耗时 ~105 秒，覆盖正常 AI 处理时间
- 绝对上限 150 秒
- 组件卸载、客户切换时自动取消
- 不触发收费模型（只读 GET）

### 3.3 白名单策略

**当前状态：** 合成客户白名单已移除，所有认证导师可使用

**保留的访问控制：**
- 导师必须是资料上传人（`source.uploadedBy === actorId`）
- PG 额度保护、幂等、并发控制不变
- 紧急暂停开关可用

---

## 4. 回滚方案

### 4.1 快速回滚（分钟级）

```bash
# 回滚到上一个稳定版本 v36（无轮询修复）
/Users/xiangshu/Troublehut/asva-workbench/.codex/tools/node_modules/.bin/tcb routes edit \
  -e root-journey-prod-d4d7pzd0a8f805 \
  --data '{"domain":"*","routes":[{"path":"/asva-api","upstreamResourceVersion":"36"}]}'
```

### 4.2 完整回滚（需要 git）

```bash
git checkout 80ae500  # v36 commit
npm run build:cloudbase
ASVA_DEPLOY_ENV_FILE=.deploy-production.env node scripts/deploy-cloudbase.mjs
```

### 4.3 紧急暂停 AI

```bash
# 通过 PG 立即停止所有模型调用
curl -X POST https://root-journey-prod-d4d7pzd0a8f805.api.tcloudbasegateway.com/v1/rdb/rest/rpc/asva_ai_budget_guard \
  -H "Authorization: Bearer $PG_API_KEY" \
  -d '{"request":{"action":"set_control","mode":"DISABLED","actorId":"staff-admin-owner-001"}}'
```

---

## 5. 监控与观察

### 5.1 生产日志查询

```bash
# 保存接口耗时
tcb logs search asva-api -e root-journey-prod-d4d7pzd0a8f805 \
  --query "POST /api/sources" -t 1h

# AUTO 触发结果
tcb logs search asva-api -e root-journey-prod-d4d7pzd0a8f805 \
  --query "ASVA_AUTO_TRIGGER" -t 1h

# PG 状态
curl -X POST https://root-journey-prod-d4d7pzd0a8f805.api.tcloudbasegateway.com/v1/rdb/rest/rpc/asva_ai_budget_guard \
  -H "Authorization: Bearer $PG_API_KEY" \
  -d '{"request":{"action":"control"}}'
```

### 5.2 健康检查

```bash
curl https://root-journey-prod-d4d7pzd0a8f805-1304965105.ap-shanghai.app.tcloudbase.com/asva-api/api/health
```

### 5.3 关键指标

| 指标 | 正常范围 | 告警阈值 |
|------|---------|---------|
| 保存响应时间 | ≤ 200ms | > 1s |
| AI 处理耗时 | 5-15s | > 60s |
| PG active | 0-2 | > 2 持续 5 分钟 |
| PG used/日 | 0-100 | > 80 |
| 错误率 | < 5% | > 10% |

---

## 6. 运营待办（独立跟踪，不阻塞功能开发）

### 6.1 后台任务可靠性优化

**当前状态：** 依赖 SCF 事件循环保活，120s 超时内有 PG 保底

**优化方向：**
- 评估腾讯云 TDMQ/CMQ 消息队列接入成本
- 或独立定时触发器兜底（非 Worker 架构）
- 目标：平台级可靠任务投递

**优先级：** P2（当前方案已可用）

### 6.2 腾讯云主动费用告警

**当前状态：** 日志记录，无主动通知

**需要配置：**
1. 腾讯云费用中心 → 费用告警 → 日消费 > 5 元
2. 资源包用量告警 → 80% 阈值
3. 云函数监控 → 执行次数/时长/错误率告警

**操作人：** 需管理员在腾讯云控制台手动配置

**优先级：** P1（费用安全）

### 6.3 并发拒绝用户体验

**当前状态：** 并发满 2 时返回错误，用户需稍后重试

**优化方向：**
- 前端友好提示："AI 正在整理其他资料，请稍后..."
- 自动排队机制（非必须）

**优先级：** P3（体验优化）

---

## 7. 后续开发保护规则

### 7.1 不得修改的核心文件

以下文件包含本轮恢复的核心机制，后续开发不得随意修改：

- `server/repository.mjs`：Stage 4 归档逻辑、PG 调用、幂等检查
- `server/ai-budget-guard.mjs`：费用守门、并发控制
- `server/index.mjs`：异步 AUTO 触发、路由定义
- `src/App.tsx`：前端轮询逻辑（递增退避）
- `scripts/deploy-cloudbase.mjs`：部署配置验证

### 7.2 必须保留的测试

以下测试保护核心机制，不得删除：

- `r048-async-archive-safety.test.mjs`：9 个异步安全测试
- `r048-eventual-consistency-retry.test.mjs`：飞书重试测试
- `r048-auto-archive-integration.test.mjs`：AUTO 触发集成测试
- `r048-stage4-archive-integration.test.mjs`：Stage 4 条件测试
- `on-demand-source-processing.test.mjs`：按需处理测试

### 7.3 变更审批要求

修改以下机制需明确审批：

1. Stage 4 归档逻辑
2. PG 额度/并发配置
3. 保存接口响应时间
4. 前端轮询频率
5. DeepSeek 调用路径

---

## 8. 故障修复记录

### R048.17 修复链

| Commit | 修复内容 |
|--------|---------|
| `2cf7941` | 飞书最终一致性重试（指数退避 1s/2s/4s） |
| `ff1bb10` | `onDemandTrigger` 传递 + `automaticMode` 包含 AUTO |
| `63a0fde` | `stage4Finalize` 包含 on-demand AUTO |
| `15b43cb` | 移除合成客户白名单 |
| `80ae500` | 异步 AUTO 触发（保存与 AI 解耦） |
| `12aa238` | 前端轮询修复（状态协议 + 递增退避） |

### 根因分析

**问题：** 新旧归档逻辑冲突导致 Stage 4 批量写入被跳过

**根因：** `stage4Finalize` 条件要求 `wasExtractReady || reconcileExistingEvidence`，刚保存的 UPLOADED Source 两者均为 false

**修复：** 增加 `(onDemand && onDemandTrigger === 'AUTO')` 条件

**附带修复：** 保存性能回退（同步等待 AI → 异步解耦）

---

## 9. 验收证据

### 9.1 生产实测数据

**保存性能（v36/v37）：**
- `POST /api/sources` → 64-79ms（500 倍提升）

**AI 处理（v34 验收）：**
- Source: `SRC-0a5ba796da5970f9321c85a9`
- 状态: COMPLETED ✅
- 正式字段: 城市、职业、年龄、性别、电话 ✅
- 补充信息: "近期在筹备自己的品牌咨询工作室" ✅
- ProfileChanges: 9 条 ✅
- PG used: +1, active: 0 ✅

### 9.2 测试覆盖

- 906 个测试全部通过
- 9 个新增异步安全测试
- 覆盖：幂等、并发、DISABLED/PAUSED、PG 不可用、无无限重试

---

## 10. 总结

R048.17 完成了以下目标：

1. ✅ 修复新旧归档逻辑冲突
2. ✅ 恢复保存性能（39s → 79ms）
3. ✅ 验证费用安全机制
4. ✅ 开放所有认证导师使用
5. ✅ 建立稳定基线，防止回归

**当前状态：** 生产稳定，可转入正常产品迭代。

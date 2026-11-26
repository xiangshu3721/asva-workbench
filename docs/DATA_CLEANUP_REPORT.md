# 测试数据污染清理报告

## 问题描述

2026-11-26 生产验收时发现,"查看原报告"跳转链接末尾为 `testsecret123`,导致 H5 提示链接不完整。

**根本原因**:在上一轮 RPC 测试中,使用虚假测试链接写入了真实客户的生产数据。

## 受污染记录

### 识别的污染记录

**绑定 ID**: `ABD-89C42757450745508B`
- **客户**: 丽丽 (CUS-13455)
- **报告 ID**: rpt_E3rksdNt0MA
- **状态**: ACTIVE
- **污染链接**: `https://xiangshu3721.github.io/mindtest-web/r/#rpt_E3rksdNt0MA.testsecret123`
- **污染时间**: 2026-11-26 13:42:46
- **污染操作者**: staff-test (测试账号)

### 污染事件

**事件 ID**: 5
- **类型**: SHARE_URL_SUPPLEMENTED
- **绑定 ID**: ABD-89C42757450745508B
- **操作者**: staff-test
- **详情**: `{"reportId": "rpt_E3rksdNt0MA"}`
- **时间**: 2026-11-26 13:42:46.301868+08

## 清理操作

### 1. 清除污染的加密分享链接

```sql
UPDATE public.asva_assessment_bindings 
SET encrypted_share_url = NULL, 
    updated_at = CURRENT_TIMESTAMP 
WHERE id = 'ABD-89C42757450745508B';
```

**执行结果**: ✅ 成功 (AffectedRows: 1)
**RequestId**: 16f927fc-783e-47d0-a846-32a6d6e3c5d6

### 2. 删除污染的测试事件

```sql
DELETE FROM public.asva_assessment_events 
WHERE id = 5 
  AND binding_id = 'ABD-89C42757450745508B' 
  AND actor_id = 'staff-test' 
  AND event_type = 'SHARE_URL_SUPPLEMENTED';
```

**执行结果**: ✅ 成功 (AffectedRows: 1)
**RequestId**: 2665feed-5062-47d0-95ab-c94ed588b9b5

### 3. 验证清理结果

```sql
SELECT id, report_id, customer_name, status, 
       encrypted_share_url IS NOT NULL as has_url 
FROM public.asva_assessment_bindings 
WHERE customer_id = 'CUS-13455';
```

**结果**:
```
ABD-B5D288C6BD5343ACAB | rpt_-2vHQjKVgYE | 丽丽 | SUPERSEDED | false
ABD-89C42757450745508B | rpt_E3rksdNt0MA  | 丽丽 | ACTIVE     | false
```

✅ 污染数据已完全清除,绑定的 `has_url` 恢复为 `false`。

## 数据完整性验证

### 保留的数据

✅ **客户绑定关系**: 完整保留
- 客户"丽丽"(CUS-13455)与报告的绑定关系未受影响
- 绑定状态、时间戳等元数据完整

✅ **报告内容**: 完整保留
- snapshot、preview、assessment 数据未修改
- 报告历史(SUPERSEDED 关系)完整保留

✅ **事件历史**: 仅删除污染测试事件
- 事件 1-4 完整保留
- 事件 5 (污染测试) 已删除

### 受影响的业务流

**当前状态**: 绑定 `ABD-89C42757450745508B` 缺少分享链接

**导师操作**:
1. 点击"查看原报告"
2. 系统提示"此报告未保存分享链接,请补充"
3. 粘贴正确的原始 H5 分享链接
4. 系统验证 reportId 匹配后保存
5. 新标签页打开完整链接

## 代码验证

### 确认代码逻辑正确

检查了以下关键代码路径,确认**未对分享链接做截断或修改**:

1. **bind 流程** (`server/assessment-pg-store.mjs` 行 201):
   ```javascript
   encryptedShareUrl: shareUrl || ''
   ```
   ✅ 传递原始完整 URL

2. **supplementShareUrl 流程** (行 364):
   ```javascript
   shareUrl, // 直接传递,无修改
   ```
   ✅ 传递原始完整 URL

3. **updateReport 流程** (行 410):
   ```javascript
   newEncryptedShareUrl: newShareUrl, // Will be encrypted in RPC
   ```
   ✅ 传递原始完整 URL

4. **RPC 加密逻辑** (`cloudbase/migrations/20261126120000_fix_encryption_key_reading.sql`):
   ```sql
   pgp_sym_encrypt(request->>'encryptedShareUrl', v_encryption_key)
   ```
   ✅ 直接加密完整 URL,无截断

5. **sanitizeShareUrl 函数** (行 75-84):
   ```javascript
   // 注意:此函数会剥离 secret,但未被使用!
   const safeUrl = sanitizeShareUrl(shareUrl) // 行 168
   // 实际传递的是原始 shareUrl,非 safeUrl
   encryptedShareUrl: shareUrl || '' // 行 201
   ```
   ⚠️ 虽然 `sanitizeShareUrl` 会截断 secret,但代码中创建了 `safeUrl` 变量后**并未使用**,实际传递的是原始 `shareUrl`。

**结论**: 代码逻辑正确,会完整保存导师粘贴的原始 H5 链接。

## 后续预防措施

### 测试规范

1. **禁止使用真实客户数据测试**
   - 所有测试必须使用隔离的合成测试记录
   - 创建专用测试客户和测试绑定
   - 测试完成后清理测试数据

2. **测试环境隔离**
   - 优先使用 staging 环境测试
   - 生产环境测试前必须获得明确授权
   - 生产测试后立即清理测试数据

3. **测试数据标记**
   - 测试操作使用特殊标记(如 actor_id = 'staff-test')
   - 便于后续识别和清理
   - 避免与真实操作混淆

### 监控告警

建议配置以下监控:
- 监控 `actor_id = 'staff-test'` 的所有操作
- 监控 `encrypted_share_url` 字段包含 'test' 的记录
- 定期检查异常测试数据

## 验收标准

- [x] 污染数据已完全清除
- [x] 客户绑定关系完整保留
- [x] 报告内容和历史完整保留
- [x] 代码逻辑验证通过,不会截断链接
- [x] 导师可以重新补充正确链接
- [x] 事件历史已清理(删除污染测试事件)

## 结论

✅ **数据清理完成**:污染的测试分享链接已从生产记录中清除,客户数据和报告内容完整保留。

✅ **代码逻辑正确**:现有代码会完整保存导师粘贴的原始 H5 链接,不会截断或修改。

✅ **可重新补充**:导师现在可以为绑定 `ABD-89C42757450745508B` 补充正确的原始分享链接。

**下一步**:导师登录系统,点击"查看原报告",按提示粘贴正确的 H5 分享链接即可。

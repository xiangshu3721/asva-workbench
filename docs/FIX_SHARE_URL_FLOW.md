# 修复"查看原报告"无法跳转问题

## 问题描述

导入报告成功后，点击"查看原报告"提示"此报告未保存分享链接"，即使导入时提供了分享链接。

## 根本原因

1. **加密密钥配置不一致**：RPC 使用 `current_setting('asva.encryption_key', true)` 获取密钥，但 CloudBase PostgreSQL 不允许设置自定义参数，密钥实际存储在 `asva_config` 表中
2. **静默失败**：当无法获取加密密钥时，bind 操作仍然成功，但 `encrypted_share_url` 被写入 NULL
3. **前端错误码检查错误**：前端检查 `err?.code === 'SHARE_URL_NOT_FOUND'`，但实际应该检查 `err?.serverCode`

## 修复方案

### 1. 数据库迁移修复

修改 RPC 函数，从 `asva_config` 表读取加密密钥：

```sql
-- 在函数开始处添加
SELECT value INTO v_encryption_key FROM public.asva_config WHERE key = 'encryption_key';
```

替换所有 `current_setting('asva.encryption_key', true)` 调用。

### 2. 禁止静默失败

修改 bind 和 update_report 动作，当提供 shareUrl 但无法获取加密密钥时，抛出错误而不是写入 NULL：

```sql
IF NULLIF(request->>'encryptedShareUrl', '') IS NOT NULL AND v_encryption_key IS NULL THEN
  RETURN jsonb_build_object('error', jsonb_build_object(
    'code', 'ENCRYPTION_KEY_MISSING',
    'message', '加密密钥未配置，无法保存分享链接',
    'status', 500));
END IF;
```

### 3. 前端错误码修复

修改 `src/App.tsx` 第 1561 行：

```javascript
// 错误
if (err?.code === 'SHARE_URL_NOT_FOUND')

// 正确
if (err?.serverCode === 'SHARE_URL_NOT_FOUND')
```

### 4. 验证流程

1. 导入报告（提供分享链接）
2. 验证数据库 `encrypted_share_url` 不为 NULL
3. 点击"查看原报告"
4. 验证新标签页打开正确的 H5 链接

## 实施步骤

1. 创建修复迁移脚本
2. 执行生产数据库迁移
3. 部署后端代码
4. 部署前端代码
5. 端到端验证

## 回滚计划

如果修复失败，可以：
1. 回滚数据库迁移（恢复旧版 RPC 函数）
2. 回滚代码到修复前版本
3. 使用部署脚本快速切换 HTTP 网关版本

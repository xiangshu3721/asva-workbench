# Stage 1 Test Report

## 当前自动测试

- Stage 0 基线与 Stage 1 新增测试：121/121 PASS
- `npm run typecheck`：PASS
- `npm run build`：PASS，保持 R001 build metadata
- `npm run schema:check`：PASS；Customers 已有 `出生日期` DateTime，Missing / Extra / TypeMismatch 为 0，`导师ID` 为 deprecated 兼容字段
- `npm run customer:data-check`：PASS；最终检查 14 Customers、8 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments，全部质量问题指标为 0

## 已覆盖

- 手机号/微信号 normalize
- exact / possible / conflict / new identity result
- 联系方式必填
- Customer 新增不创建 Appointment
- active Product 与 Enrollment 去重
- AI Draft 不直接写入
- ProfileChanges 与来源元数据既有链路回归

## 待最终验收

`RUN_FEISHU_INTEGRATION_TESTS=true npm run stage1:integration` 已在授权后真实通过：批次 `STAGE1_IT_1791385895823_ae0e0e`，包含 Customer CRUD/回读、phone-only、WeChat-only、无联系方式拒绝、重复电话/微信、昵称 possible match、identity conflict、birth_date、派生年龄/年份、Provenance、ProfileChanges、Enrollment cancel/restore、幂等重试；结果报告先于清理生成，批次随后清理并复查 Data Check。期间出现的失败批次均已精确清理，根因分别为 Phone 空字符串、Text 派生字段类型和 Feishu DateTime 回读类型，均已修复。
浏览器逐项点击验收因 CUA 桥接初始化连续超时未完成，记为 BLOCKED；本阶段不部署 Production。

# Stage 1 Test Report

## 当前自动测试

- Stage 0 基线与 Stage 1 新增测试：119/119 PASS
- `npm run typecheck`：PASS
- `npm run build`：PASS，保持 R001 build metadata
- `npm run schema:check`：PASS；无 Missing / Extra / TypeMismatch，`导师ID` 仍为 deprecated 兼容字段
- `npm run customer:data-check`：运行成功但结果为 FAIL；当前检查 21 Customers、8 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments，仍有 1 条缺少联系方式记录，其余检查项为 0

## 已覆盖

- 手机号/微信号 normalize
- exact / possible / conflict / new identity result
- 联系方式必填
- Customer 新增不创建 Appointment
- active Product 与 Enrollment 去重
- AI Draft 不直接写入
- ProfileChanges 与来源元数据既有链路回归

## 待最终验收

`RUN_FEISHU_INTEGRATION_TESTS=true npm run stage1:integration` 已建立门控脚本并先生成快照；实际 HTTP Customer 写入后回读收到 `FEISHU_UNAVAILABLE`，因此不能记为 PASS。测试产生的 `STAGE1_TEST_` 记录未自动删除。本阶段不部署 Production。
浏览器逐项点击验收、Debug 信息人工验收仍未完成。

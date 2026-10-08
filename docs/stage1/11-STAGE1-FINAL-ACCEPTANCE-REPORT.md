# ASVA Stage 1 Final Acceptance Report

日期：2026-10-07
分支：`stage-1-customer-foundation`
版本：`R003`，Stage 1 已冻结，非阻塞 UX 问题进入 backlog。

## 1. 操作前快照

写入前快照：`stage1-backup/stage1-final-acceptance-2026-10-07T14-58-08-832Z.json`，权限 `0600`。

快照计数：Customers 21、Staff 8、Products 4、Enrollments 2、ServiceRecords 2、ProfileChanges 6、Appointments 14。真实集成脚本另在每批次写入前生成同类快照。

## 2. 字段与历史数据处理

- `出生日期`：已在 Production Customers 创建为 DateTime，字段 ID `fldaGYJTka`，格式 `yyyy/MM/dd`。
- Schema Check：PASS；Customers live fields 103，缺失/类型不匹配为 0；`导师ID` 仅保留为 deprecated 只读兼容字段。
- 已删除 6 条旧 `STAGE1_TEST_` Customer：`CUS-9e920da53172eeec9366`、`CUS-d5a670a5dc0998f84a38`、`CUS-8585712890a5214799af`、`CUS-2342abbe7b0c9734aaee`、`CUS-78dd71ae6c5446fa19b7`、`CUS-4a5296e1e7a334941b85`。
- 已删除 `CUS-CF-E2E-仅测试` / `Cloudflare联调测试`。
- ASVA TEST DATASET V1：未触碰；删除始终限于授权目标 ID 或本轮随机 `STAGE1_IT_` 批次，未发现未知客户关联。

## 3. 真实 Feishu 集成

最终批次：`STAGE1_IT_1791386325792_f5b9d7`。结果报告在清理前生成：`stage1-backup/stage1-integration-result-2026-10-07T15-18-45-792Z.json`；写入遥测 27 条、失败 0 条，回读遥测 14 条、失败 0 条，每条包含 record_id/request_id/write_status/readback_status/retry_count/final_result。

- Customer CRUD：PASS；create/readback/update/refresh、phone-only、WeChat-only、无联系方式拒绝均 PASS。
- Identity Resolver：PASS；重复 phone、重复 WeChat、昵称 possible match、phone A + WeChat B identity conflict 均按预期返回。
- `birth_date`：PASS；写入/回读/刷新、派生年龄/年份、ProfileChanges 和来源元数据 PASS。
- Provenance：PASS；city、marital_status、occupation、current_goal、birth_date 的 source/operator/changed_at 回读 PASS。
- ProfileChanges：PASS；`field_key`、`field_name`、`old_value`、`new_value`、`source`、`operator_id`、`changed_at` 均生成并回读。
- Enrollment：PASS；单/多课程、重复防止、编辑、CANCELLED、restore、refresh recovery PASS。
- Source of Truth：PASS；Enrollment 是已报名课程唯一事实源，`intended_course` 只表示课程意向，无 fallback。
- Appointment：PASS；Customer create/update 未创建 Appointment。
- Feishu unavailable：最终批次未出现；此前失败均已定位并清理，未重复创建未知 Customer。失败根因已确认：空手机号写入 Phone 字段、Text 派生字段误写 Number、DateTime 回读未标准化。
- Retry/idempotency：PASS；仅对可重试读请求有限重试，schema/permission/validation 不重试；相同 `operationId` 重试未产生重复 Customer。
- 测试清理：PASS；最终批次清理 4 Customers、2 Enrollments、11 ProfileChanges；清理后 `STAGE1_IT_`、`STAGE1_TEST_` 和 Cloudflare 目标均为 0。

## 4. 最终数据质量与自动检查

- Customer Data Check：PASS；14 Customers、8 Staff、4 Products、2 Enrollments、2 ServiceRecords、6 ProfileChanges、14 Appointments；missingContact、duplicateCustomerId、duplicatePhone、duplicateWechat、danglingMentor、danglingEnrollmentCustomer、danglingEnrollmentProduct 全部为 0。
- `npm test`：PASS，121/121。
- `npm run typecheck`：PASS。
- `npm run build`：PASS，仍为 R001。
- `npm run schema:check`：PASS。

## 5. 浏览器验收

状态：`PASS_WITH_MINOR_ISSUES`。产品负责人已完成真实使用验收，少量 UX 细节进入 Stage 1 backlog。

## 6. FAIL / BLOCKED

- BLOCKED：无 Stage 1 产品阻塞项。
- FAIL：无。

## Final Gate

`MANUAL_PRODUCT_OWNER_ACCEPTANCE = PASS_WITH_MINOR_ISSUES`

`STAGE1_COMPLETE = YES`

`BASELINE_RELEASE = R003`

Stage 1 已冻结，进入 Stage 2；不因非阻塞 UX 细节继续修改 Stage 1 业务。

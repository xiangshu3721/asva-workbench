# Customer Data Quality V1

命令：`npm run customer:data-check`

检查项：缺失/重复 Customer ID、重复标准化手机号、重复标准化微信号、缺少联系方式、缺少昵称、悬空导师引用、Enrollment 悬空 Customer、Enrollment 悬空 Product。

最终实时结果：检查了 Customers 14、Staff 8、Products 4、Enrollments 2、ServiceRecords 2、ProfileChanges 6、Appointments 14；missingContact、duplicateCustomerId、duplicatePhone、duplicateWechat、danglingMentor、danglingEnrollmentCustomer、danglingEnrollmentProduct 全部为 0。旧 `STAGE1_TEST_`、本轮 `STAGE1_IT_` 和 Cloudflare 联调测试目标均已按快照与精确 ID 清理；未触碰 ASVA TEST DATASET V1。

检查输出只返回数量与结构化状态，不输出完整手机号、微信号、客户情况或 AI 摘要。

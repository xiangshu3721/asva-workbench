# Customer Data Quality V1

命令：`npm run customer:data-check`

检查项：缺失/重复 Customer ID、重复标准化手机号、重复标准化微信号、缺少联系方式、缺少昵称、悬空导师引用、Enrollment 悬空 Customer、Enrollment 悬空 Product。

当前基线结果：检查了 Customers 15、Staff 8、Products 4、Enrollments 2、ServiceRecords 20、ProfileChanges 13、Appointments 17；发现 1 条既有 Customer 缺少手机号和微信号，其他检查项为 0。该记录需在迁移前人工确认，不在本阶段静默补写。

检查输出只返回数量与结构化状态，不输出完整手机号、微信号、客户情况或 AI 摘要。

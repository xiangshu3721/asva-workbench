# Enrollment Source of Truth

- 课程报名事实唯一来源是 `Enrollments`，Customer 的 `intended_course` 只做兼容摘要。
- Customer 与 Product 是 N:M，通过 Enrollment 关联。
- 课程选择器只读取 `Products` 中 `ACTIVE / 在售` 产品，不在前端硬编码课程名称。
- 新增客户可选择 0～N 门课程，分别创建 Enrollment；同一 Customer + Product 不重复创建，编辑使用 ADD / KEEP / REMOVE，REMOVE 统一写 `CANCELLED`，不使用 `INACTIVE`，不物理删除历史；再次选择优先恢复原 `CANCELLED` 记录。
- Stage 1 Customer 新增/编辑不创建 Appointment；旧 `needsFollowup` 字段只兼容读取，不再触发预约。
- 部分写入必须明确返回已创建 Customer、成功/失败 Enrollment 与 operation_id；重试不能重复创建 Customer。
- AI Context 中课程意向使用 `course_interest` / `commercial_context`，不得放入 `enrolled_courses`。

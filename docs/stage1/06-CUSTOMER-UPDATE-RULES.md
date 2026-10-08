# Customer Update Rules

## 统一更新边界

Customer 创建、编辑、AI 确认、服务反馈涉及的主档案更新，必须经过同等职责的 Customer Update 规则：权限、字段合法性、normalize、identity conflict、old/new、provenance、ProfileChanges、`profile_updated_at` 与 profile version。

当前实现逐步收敛在服务端 `persistCustomerProfile` 与本地 `applyProfileUpdates`；Stage 1 不重写全量 Repository。

## 规则

- AI 只生成 Draft；只有管理员/导师明确确认后才可写入。
- Stable Fact（手机号、微信号、出生日期、已确认性别）冲突不得静默覆盖；展示当前值/新值，等待人工确认。
- Mutable Fact（城市、婚姻、职业、工作状态、关系状态）允许更新当前快照，并写 ProfileChanges。
- 重要字段包括联系方式、城市、职业、婚姻/关系状态、核心需求、目标、当前导师和已有兼容业务字段。
- 普通格式变化不生成无意义历史。
- `current_mentor_id` 是唯一新写字段；旧 `导师ID` 只读 deprecated。
- ProfileChanges 由 Customer Schema Contract 的 `history_policy=TRACK` 驱动；normalize 后相同的值不写历史。`birth_date` 变更写历史，存在 `birth_date` 时派生的 `age` / `birth_year` 不单独写历史；仅有 legacy age 时保留兼容变更记录。

## Schema Change Rules

新增字段前必须证明：现有字段无法表达；属于长期 Customer Current Snapshot；不是理论结论、一次服务、历史事件、独立关系实体或 Appointment 状态；产品已确认长期保留；同时更新 schema contract、字段分类、读写测试和迁移说明。

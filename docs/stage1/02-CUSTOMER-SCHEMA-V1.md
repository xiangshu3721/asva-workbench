# Customer Schema V1

## 正式语义

`Customer = 一个长期存在的人物主体的当前已确认快照`。Customer 不是 Appointment、ServiceRecord、ServiceCase、销售机会、AI 画像或心理诊断。

本阶段不新建第二张画像表，不推翻现有 Customers 表；以下矩阵冻结现有字段的用途与写入边界。

| 字段族 | 字段 | 类型 / 属性 | 核心 / 可编辑 | 来源 / AI写入 | 历史与迁移 |
|---|---|---|---|---|---|
| Identity | `customer_id`, `nickname`, `gender`, `birth_date`, `birth_year`, `age`, `city`, `hometown` | `birth_date` 为 canonical 事实；`birth_year` 与 `age` 由其派生优先；仅知道年龄时允许 legacy age，不伪造生日 | ID 不可编辑；其余 ADMIN 可编辑 | 结构化录入、客户明确表达、管理员确认；AI 只能候选 | 真实表补充 `出生日期` 后启用；旧出生年份/年龄兼容读取 |
| Contact | `phone`, `wechat` | 标准化匹配值，展示保留原值 | ADMIN 可编辑；至少一项 | 结构化录入 / 管理员确认 | 重要修改写 ProfileChanges |
| Source | `source`, `referrer_name`, `created_at` | 来源与创建元数据 | `referrer_name` 仅 ADMIN 可编辑 | 结构化录入 / 历史导入 | 自由文本介绍人暂保留 |
| Family & Relationship | `marital_status`, `children_summary`, `family_summary`, `parents_relationship`, `father_summary`, `mother_summary`, `relationship_with_father`, `relationship_with_mother`, `siblings`, `family_events`, `family_support_level`, `relationship_status`, `partner_summary`, `marriage_years`, `relationship_satisfaction`, `relationship_conflicts`, `communication_pattern`, `conflict_pattern`, `relationship_goal`, `children_detail`, `parent_child_relationship`, `parenting_problem`, `parenting_values` | 当前事实 / 主观描述 / 可变事实 | ADMIN 确认后可编辑 | 客户明确表达、管理员/导师事实输入；AI 不可直接写事实 | 重要变化写 ProfileChanges；未来理论结果不进主表 |
| Career & Reality | `occupation`, `industry`, `position`, `work_years`, `job_status`, `income_range`, `career_stage`, `career_satisfaction`, `career_problem`, `career_goal`, `entrepreneurship_experience` | 可变事实 / 当前状态 | ADMIN 可编辑 | 客户表达、管理员确认；AI 只生成 Draft | 现有字段复用 |
| Lifestyle & Body | `education`, `living_status`, `sleep`, `diet`, `routine`, `sports`, `life_satisfaction` | 自述 / 当前状态 | ADMIN 确认后可编辑 | SELF_REPORTED / ADMIN_CONFIRMED | 不扩展医疗结构 |
| Person & Preference | `hobbies`, `reading`, `travel`, `art_preferences`, `social_preference`, `self_description`, `personality_traits`, `communication_style`, `decision_style`, `emotion_expression`, `stress_response`, `conflict_style`, `action_style`, `strengths`, `common_blocks`, `core_values`, `family_values`, `career_values`, `money_values`, `relationship_values`, `success_definition`, `happiness_definition`, `freedom_definition`, `growth_attitude` | 自述或主观描述 | 必须标注来源；AI 不能伪装事实 | USER_EXPLICIT / ADMIN_CONFIRMED；AI 仅 Draft | 理论 Lens 不直接新增到此族 |
| Current Snapshot | `current_core_issue`, `secondary_issues`, `current_stressors`, `current_goal`, `current_expectation`, `current_resources`, `support_system`, `current_barriers`, `energy_state`, `recent_major_changes` | 可变当前状态 | ADMIN 确认后可编辑 | 客户表达、管理员/导师事实输入、AI_EXTRACTED_CONFIRMED | 每次重要确认更新版本并留历史 |
| Service Summary | `current_mentor_id`, `profile_updated_at`, `profile_schema_version` | 当前摘要 / 元数据 | `current_mentor_id` 由分配链路更新 | 结构化操作、管理员确认 | 旧 `导师ID` 只读 deprecated；详细历史来自 ServiceRecord |
| Commercial Summary | `is_paid`, `paid`, `sabc`, `grade`, `intended_course` | 兼容业务字段；`intended_course` 只表示课程意向 | 保留兼容；不让 AI 自动修改 | 人工确认 / 既有业务链路 | 课程报名真相唯一来自 Enrollment |

Customer 字段的 `history_policy` 由 Schema Contract 驱动：重要当前事实为 `TRACK`，`age`/`birth_year` 为 `DERIVED`（无 birth_date 的 legacy age 作为兼容输入保留变更记录），AI 摘要与 Brief 为 `NO_TRACK`。
| AI Cache | `brief`, `ai_customer_summary` | `AI_CACHE` / `DERIVED` | 不作为事实编辑 | RULE / DEEPSEEK 输出；不得直接覆盖事实 | 失败不覆盖旧人工事实，可标记 stale |
| System Metadata | `profile_field_meta_json`、`profile_updated_at`、档案版本元信息 | provenance / version | 服务端维护 | 系统写入 | 不与 Release Counter 混用 |

## 属性枚举

正式字段属性使用：`STABLE_FACT`、`MUTABLE_FACT`、`SELF_REPORTED`、`SUBJECTIVE_DESCRIPTION`、`CURRENT_STATE`、`DERIVED`、`AI_CACHE`、`LEGACY`、`DEPRECATED`。

新增 Customer 字段必须先通过 `docs/stage1/06-CUSTOMER-UPDATE-RULES.md` 的 Schema Change Rules；理论模型、一次服务、历史事件、Appointment 状态不得直接变成 Customer 字段。

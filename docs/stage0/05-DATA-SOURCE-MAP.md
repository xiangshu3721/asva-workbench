# Data Source Map

| 领域 | production 真源 | demo 真源 | 写入边界 |
|---|---|---|---|
| Customers | Feishu Customers | seed/localStorage | production 仅服务端 API |
| Staff/Mentors | Feishu Staff | seed/localStorage | ADMIN；导师不可登录管理员端 |
| Products | Feishu Products | seed/localStorage | 只读展示 |
| Enrollments | Feishu Enrollments | seed/localStorage | 服务端写入 |
| ServiceRecords | Feishu ServiceRecords | seed/localStorage | 服务端写入 |
| ProfileChanges | Feishu ProfileChanges | seed/localStorage | 服务端写入 |
| Appointments | Feishu Appointments | seed/localStorage | 外部预约入口默认冻结 |
| AI Query/Brief | 服务端 repository + DeepSeek/规则 | 本地 deterministic AI | 不改现有算法，本轮只补来源与存储边界 |

任何 production 读失败必须保留错误、request_id 和数据源信息；不能改读 demo。

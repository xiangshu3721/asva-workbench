# Schema Contract

契约源文件：`server/schema-contract.mjs`。每个字段定义 `internal_key`、`feishu_name`、`type`、`required`、`nullable`、`readable`、`writable`、`enum`、`date_format`、`deprecated`。

覆盖 Customers、Staff、Products、Enrollments、ServiceRecords、ProfileChanges，并保留 appointments 只读冻结契约。

现场检查：`npm run schema:check`。输出 Missing、Extra、TypeMismatch、Deprecated，并将已知差异写成 Schema Gap，而不是静默忽略。

已确认规则：

- `微信号` 为 Customers 身份字段，现已存在于现场表和映射。
- `父亲情况` 当前现场表已存在；若未来环境缺失，应报告 `SCHEMA_GAP`，不自动扩表。
- Customers 的 `导师ID` 是历史字段：兼容读取、只读 deprecated，新代码写 `当前导师ID`。
- ProfileChanges 的 `field_key=marital_status` 必须写 `field_name=婚姻状态`。

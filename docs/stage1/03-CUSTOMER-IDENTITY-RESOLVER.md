# Customer Identity Resolver V1

实现：`shared/customer-foundation.mjs`，服务端与本地仓库共用同一套标准化与解析规则。

## 解析优先级

1. `customer_id` exact
2. `phone` exact match
3. `wechat` exact match
4. `nickname` 只产生 `POSSIBLE_MATCH`，永远不能单独自动认定同一人

返回：`EXACT_MATCH`、`POSSIBLE_MATCH`、`CONFLICT`、`NEW_CUSTOMER`，并包含 `matched_customer_id`、`match_reasons`、`confidence` 与安全的匹配记录摘要。

## 标准化

- 手机号 trim、去空格/常见分隔符；中国大陆 `+86` 统一为 11 位格式；其他国际号码保留 `+` 与国家码。
- 微信号匹配使用 trim + 小写规范化；原始展示值不改写。
- 手机号与微信号至少一项；前端提示，服务端以 `CUSTOMER_CONTACT_REQUIRED` 再校验。

正式创建不开放无联系方式例外；未来历史导入若需要例外，必须显式使用 `IMPORTED_HISTORY` 迁移边界。

## 冲突边界

手机号命中 Customer A、微信号命中 Customer B 时返回 `IDENTITY_CONFLICT`，阻止创建或覆盖，不自动合并、不自动选择。重复手机号/微信号同样阻止自动写入；同名只提示并允许管理员确认后新建。

Stage 1 不做 Customer Merge；只识别、提示、阻止继续产生重复。

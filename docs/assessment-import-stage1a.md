# 心理测评接入 Stage 1A — star Provider 合同与安全边界

状态：**Draft / 离线协议层，尚未执行集成或生产验证**。

## 最小实现

- `shared/assessment-import-star-contract.mjs`：严格限定 `https://xiangshu3721.github.io/mindtest-web/r/#...` 的完整链接格式，解析 `reportId` 与 `linkSecret`（秘密只能留在服务端）；拒绝所有其他 Host、路径、查询参数和伪装 URL。**不得**通过粘贴网址向任意目标发起 HTTP 请求。
- `normalizeStarReportPreview`：对给定 `reportId` 核验回包为 `star`、兼容的 `schemaVersion`、完成时间、两组三词结果；预览仅输出最小必要的结构化字段，不回传链接密钥、原始答题、`ownerToken`、扩展字段或测评 consent 数据。
- 8 个纯合成测试；**尚未运行**，仍待 Codex 使用项目完整依赖执行定向与全量测试。

## 安全职责分层

1. **预览**：ASVA 用户已登录、有目标客户读取权限；从粘贴的完整 URL 提取凭据后，服务端向代码中固定的可信报告服务发起请求，不跟随任何指向内网或第三方主机的重定向。限制响应大小、超时、限流，不记录凭据或原始报告。
2. **报告服务**：必须先确认稳定生产服务、撤销/失效语义、幂等性及私有持久化。源码存在不等于线上可用。没有批准不得读取真实报告。
3. **人工确认**：预览只供核对，不能创建客户绑定、Source、Evidence、AI Context。昵称不是唯一标识，源报告同意 `mentor_read` 不等于客户同意 ASVA 存档或 AI 使用。
4. **存储**：下一个独立阶段建立受控索引、完整加密 JSON 快照、审计与全局报告唯一性约束；新增后台操作必须有原子性与补偿/重试设计。不能仅靠无状态的纯 parser 完成这些工作。
5. **AI**：只有客户确认绑定、存储成功且取得匹配用途授权后才可生成证据；未获同意不得向外部模型发送报告，默认阻断销售场景。

## 未做与明确阻断

- 本 PR **不**增加 HTTP API、定时器、数据库表、云配置、自动同步或前端页面；不做任何生产写入、CloudBase 调用、真实客户链接测试。
- `star` 源数据读取接口 `POST /v1/results/read` 的线上可用性/完整性/撤销及稳定持久化仍未核实；下一步需要从测试环境的**纯合成报告**验证，不使用真实客户。
- SEFS、个人充电及其他测评暂不支持。不能仅因来源站点有“分享”按钮就扩大白名单。
- 导师错绑、跨客户冲突、历史保留、撤销/转移、AI 污染回滚待后续独立 PR 完成。

## 验收命令

```sh
npx vitest run shared/assessment-import-star-contract.test.mjs
npm test
npm run typecheck
npm run build
npm run build:cloudbase
```

验收除 PASS/FAIL 外，需报告最终 SHA、对分享密钥泄漏路径的审查、是否严格零运行时接线和生产副作用。后续服务 API 与数据层另立受控 PR。

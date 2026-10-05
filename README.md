# ASVA 工作台

ASVA 内部客户服务与经营管理 H5 的第一版可运行原型。

## 当前版本：V1.0 管理员工作台与只读 AI 数据查询

当前只服务一条状态驱动链路：预约进入 → 管理员分配导师 → 线下真人沟通 → 管理员代录反馈 → AI 整理确认 → 预约完成。

当前实现：

- 演示登录：手机号 + 验证码（默认管理员手机号 `15021512537`，验证码固定为 `888888`）
- 本地演示账号：管理员 `15021512537`、`15021512538`；导师账号仅保留为业务归属数据，不能登录
- 登录规则：只有 `role=ADMIN`、`status=ACTIVE`、`login_enabled=true` 才能进入工作台；导师登录统一提示“导师端暂未开放，请联系管理员。”
- API / Repository 权限边界：所有业务数据读取和写入均由服务端校验 ADMIN；导师仍可作为分配对象
- 三项底部导航：首页、客户、我的
- 管理员首页：待分配、待跟进、待反馈和已完成状态卡片
- 客户列表：搜索、待处理、待跟进、已完成
- 客户单页：基础信息、当前困扰、帮助期待、AI Brief、历史预约、历史服务和服务判断信息
- 服务反馈：管理员代导师填写沟通主题、结果、核心需要等信息，确认 AI 整理后保存
- 客户画像：管理员可用自然语言或浏览器支持的语音输入描述客户，AI 生成新增 / 更新草稿；冲突信息先提示，只有管理员确认后才写入
- 画像来源：`USER_EXPLICIT`、`MENTOR_CONFIRMED`、`MENTOR_OBSERVATION`、`AI_INFERENCE`，AI 推测默认 `confirmed=false`
- 客户详情：按“TA是谁、工作与事业、家庭与关系、兴趣与生活、价值观与特点、当前状态”展示已记录信息，不展示底层大字段表
- Appointment 作为 Case 承载的状态机：`WAIT_ASSIGN` → `WAIT_FOLLOW_UP` → `WAIT_FEEDBACK` → `COMPLETED`
- 导师账户管理：管理员可新增、编辑和软停用导师；导师账户 `login_enabled=false`，停用账户保留历史记录且不能承接新分配
- 服务记录审计：`mentor_id` 表示实际服务导师，`operator_id` 表示在系统中录入记录的管理员
- 管理员专属：团队管理和基础数据看板
- 浏览器 `localStorage` 持久化演示操作

暂时隐藏：独立预约页、复杂 Follow-up、销售 AI、课程中心、复杂课程推荐和完整经营驾驶舱。

## 启动本地演示

```bash
npm install
npm run dev
```

打开终端输出的本地地址即可。生产构建：

```bash
npm run build
npm run typecheck
npm test
```

## GitHub Pages

项目通过 `.github/workflows/deploy-pages.yml` 自动发布到 GitHub Pages。Pages 使用本地演示数据和默认验证码，不包含飞书或 DeepSeek 密钥；真实 HTTP / 飞书服务需要单独部署 `server/index.mjs`，再配置 `VITE_API_BASE_URL`。

## 接入真实 HTTP / 飞书 / DeepSeek

已接入服务端 Repository，使用解忧小屋同一套飞书应用和 DeepSeek 配置。先复制环境变量模板：

```bash
cp .env.example .env.local
# 在 .env.local 填写 FEISHU_APP_SECRET 和 DEEPSEEK_API_KEY
npm run dev:server
VITE_API_BASE_URL=http://127.0.0.1:8788 npm run dev
```

服务端入口是 `server/index.mjs`，前端只通过 `/api` 调用；DeepSeek 密钥和飞书应用密钥不会进入浏览器。`/api/health` 会显示配置状态但不会返回密钥。

当前 Base 结构：原预约表继续作为预约主表，并使用 Customers、Appointments、ServiceRecords、Staff、Products 五类数据；结构化客户档案字段已并入 `ASVA 客户`，每条 Customer Record 表示客户当前完整档案。`ASVA 画像变更历史`（`tblTH3OmBuzUsBVu`）保留用于重要字段审计，并在其中维护 `field_key`、`field_name`、`operator_id`、`changed_at`。旧 `ASVA 客户画像` 已改名为 `ASVA 客户画像（已停用）`，当前为 0 条记录。

飞书显示字段与内部 key 由 `server/field-mapping.mjs` 统一维护：Repository 始终使用英文 key，飞书写入使用中文显示名；字段改名迁移期间，读取层集中兼容旧字段名，避免逐个业务模块散落兼容逻辑。

## 架构边界

页面不直接依赖飞书字段。当前页面 → `src/clientApi.ts` → HTTP `/api` → `server/repository.mjs` → 飞书多维表；未配置 `VITE_API_BASE_URL` 时保留本地演示模式。

当前页面实际依赖的业务数据只有 Customers、Appointments、ServiceRecords（代码中的 `sessions`）、Staff、简单 Products，以及 Customer 内嵌档案字段和画像变更历史；旧画像表不再参与读取、写入或查询。

服务端职责：

- `server/repository.mjs`：读取/更新 Customer 完整档案、画像历史和服务记录，并在服务端执行仅 ADMIN 可用的权限校验
- `server/deepseek.mjs`：接待前 Brief、跟进后总结、当前状态、下一步建议和画像草稿提取
- `server/index.mjs`：HTTP API 与动作状态迁移

当前真实接入仍有一个明确边界：`X-Staff-Id` 只是当前内部联调身份头，不是生产登录认证。正式部署前需要接入手机号验证码、飞书身份或现有解忧小屋会话，并由服务端签发会话。

## V0.6 全局 AI 助手

- 管理员可从所有业务页面打开全局悬浮 AI 助手，查询客户、预约状态、导师、报名和已记录营收
- 助手只读，不执行客户、预约、服务记录或画像写入；服务端 `/api/ai/query` 只允许 ACTIVE ADMIN 调用
- 支持浏览器能力范围内的中文一次性语音输入、异步语音回复、重播和停止播放；不支持时可继续使用文字输入
- 支持当前客户详情上下文、简单追问和浏览器本地最近对话；真实数据缺失时明确提示，不编造营收或报名数据

## V0.7 AI 查询机制

查询链路已升级为：`自然语言 → QueryPlanner → EntityResolver / DateRangeResolver → 权限校验 → Repository Query → Aggregator → ResultValidator → AnswerGenerator`。

- 客户姓名支持空格、全半角、昵称后缀、手机号和一字符近似匹配；多个候选会明确要求确认
- 支持客户详情从 Customers 当前完整档案直接读取，并聚合预约、服务记录、报名和课程表
- 支持时间范围：今天、昨天、本周、上周、本月、上个月、今年、去年、最近 N 天 / N 个月
- “上个月客户数据”会进入 `CUSTOMER_SUMMARY`，不再当作客户姓名搜索
- 只统计 `payment_status = PAID` 的报名金额；报名表未配置、字段缺失、结果重复或关联异常会返回数据源错误，不伪装成“没有数据”
- 每次查询返回 QueryPlan 和 QueryExecutionContext；服务端管理员可通过 `/api/ai/query-logs` 查看最近 100 条调试记录

真实飞书环境的手动新增客户会从 `ASVA 产品` 读取有效课程，并把选择写入 `ASVA 报名记录` 的结构化关系。当前解忧小屋 Base 已配置 `FEISHU_ENROLLMENTS_TABLE_ID`；字段显示名使用中文，代码仍通过内部英文 key 映射。报名关系按 `客户ID + 产品ID` 去重，已报名课程与客户的意向课程分开保存。

## V1.0 自然语言全业务数据引擎

V1 保留 V0.7 的本地演示和 HTTP 查询入口，但将查询能力收敛到同一套共享语义引擎 `shared/semantic-engine.mjs`：

- `SCHEMA_REGISTRY`：Customers（含完整结构化客户档案字段）、Appointments、ServiceRecords、Staff、Products、Enrollments 的字段、数据类型、时间字段、搜索 / 筛选 / 分组和敏感字段元数据
- `ENTITY_REGISTRY` 与 `RELATIONSHIP_GRAPH`：客户、导师、课程、预约、服务记录、报名记录及其关联关系
- `BUSINESS_GLOSSARY`、`METRIC_REGISTRY`、`DIMENSION_REGISTRY`：业务术语、固定指标公式和可分组维度；指标计算不交给模型
- QueryDSL：`ENTITY_DETAIL`、`ENTITY_LIST`、`COUNT`、`AGGREGATE`、`GROUP_AGGREGATE`、`SUMMARY`、`RANK`、`TREND`、`COMPARE`
- 上下文槽位：只在代词、省略和明确承接表达出现时继承；独立问题会清空上轮客户、课程、时间和筛选条件
- 数据依据与质量：返回使用的数据源、时间字段、聚合方式、匹配行数、覆盖率和异常提示；缺失报名表会区分为数据源不可用
- 服务端 DeepSeek（已配置时）：只发送问题和语义注册表用于自然语言理解，不发送客户明细，不计算指标，不执行写入；不可用时由确定性 QueryPlanner 安全降级
- 管理员只读：AI 查询没有创建、修改、删除正式业务数据的工具入口

V1 黄金查询集包含 59 条用例，覆盖实体解析、模糊匹配、时间范围、筛选、分组、排名、趋势、对比、上下文继承、独立问题清空、歧义、无数据和缺失数据源。

## 目录

```text
src/
  App.tsx          V0.4 页面、交互和演示工作流
  domain.ts        领域类型与权限相关数据结构
  data.ts          可替换的演示数据
  api.ts           页面使用的 API 边界
  clientApi.ts     本地 API / HTTP API 统一客户端
  repositories.ts  数据 Repository 边界与本地实现
  profile.ts       Customer 内嵌档案字段、自然语言本地兜底和展示分组
  styles.css       移动优先界面样式
server/
  index.mjs        ASVA HTTP 服务
  repository.mjs   飞书数据 Repository 与权限裁剪
  field-mapping.mjs 飞书中文显示名与内部英文 key 的统一映射
  deepseek.mjs     DeepSeek 服务端调用
  feishu.mjs       飞书 token 和多维表 API 客户端
shared/
  semantic-engine.mjs  浏览器与 HTTP 服务共用的 Schema / DSL / Planner / Compiler / Aggregator
```

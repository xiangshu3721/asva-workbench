# ASVA 工作台

ASVA 内部客户服务与经营管理 H5 的第一版可运行原型。

## 当前版本：V0.5.1 管理员工作台

当前只服务一条状态驱动链路：预约进入 → 管理员分配导师 → 线下真人沟通 → 管理员代录反馈 → AI 整理确认 → 预约完成。

当前实现：

- 演示登录：手机号 + 验证码（默认管理员手机号 `15021512537`，验证码固定为 `888888`）
- 本地演示账号：管理员 `15021512537`、`15021512538`；导师账号仅保留为业务归属数据，不能登录
- 登录规则：只有 `role=ADMIN`、`status=ACTIVE`、`login_enabled=true` 才能进入工作台；导师登录统一提示“导师端暂未开放，请联系管理员。”
- API / Repository 权限边界：所有业务数据读取和写入均由服务端校验 ADMIN；导师仍可作为分配对象
- 三项底部导航：首页、客户、我的
- 管理员首页：待分配、跟进中、待反馈和已完成状态卡片
- 客户列表：搜索、待处理、跟进中、已完成
- 客户单页：基础信息、当前困扰、帮助期待、AI Brief、历史预约、历史服务和服务判断信息
- 服务反馈：管理员代导师填写沟通主题、结果、核心需要等信息，确认 AI 整理后保存
- 客户画像：管理员可用自然语言或浏览器支持的语音输入描述客户，AI 生成新增 / 更新草稿；冲突信息先提示，只有管理员确认后才写入
- 画像来源：`USER_EXPLICIT`、`MENTOR_CONFIRMED`、`MENTOR_OBSERVATION`、`AI_INFERENCE`，AI 推测默认 `confirmed=false`
- 客户详情：按“TA是谁、工作与事业、家庭与关系、兴趣与生活、价值观与特点、当前状态”展示已记录信息，不展示底层大字段表
- Appointment 状态机：`WAIT_ASSIGN` → `FOLLOWING` → `WAIT_FEEDBACK` → `COMPLETED`
- 导师账户管理：管理员可新增、编辑和软停用导师；导师账户 `login_enabled=false`，停用账户保留历史记录且不能承接新分配
- 服务记录审计：`mentor_id` 表示实际服务导师，`operator_id` 表示在系统中录入记录的管理员
- 管理员专属：团队管理和基础数据看板
- 浏览器 `localStorage` 持久化演示操作

暂时隐藏：独立预约页、复杂 Follow-up、全局 AI、销售 AI、课程中心、复杂课程推荐和完整经营驾驶舱。

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

当前 Base 结构：原预约表继续作为预约主表，并使用 Customers、Appointments、ServiceRecords、Staff、Products 五类数据；本轮新增真实飞书表 `ASVA 客户画像`（`tblgtkXFXhPrDEVQ`）和 `ASVA 画像变更历史`（`tblTH3OmBuzUsBVu`），并在 Staff 增加 `login_enabled`、在 ServiceRecords 增加 `operator_id`，服务记录还保留 `profile_text`、`profile_updates_json`、`profile_update_confirmed` 字段。原表的“预约编号”作为 `appointment_id`，新增的 `status` 字段使用 `WAIT_ASSIGN / FOLLOWING / WAIT_FEEDBACK / COMPLETED`。

## 架构边界

页面不直接依赖飞书字段。当前页面 → `src/clientApi.ts` → HTTP `/api` → `server/repository.mjs` → 飞书多维表；未配置 `VITE_API_BASE_URL` 时保留本地演示模式。

当前页面实际依赖的业务数据只有 Customers、Appointments、ServiceRecords（代码中的 `sessions`）、Staff、简单 Products，以及画像和画像变更历史；旧扩展字段保留用于兼容，但不参与首页待办判断。

服务端职责：

- `server/repository.mjs`：读取/更新画像表、画像历史和服务记录，并在服务端执行仅 ADMIN 可用的权限校验
- `server/deepseek.mjs`：接待前 Brief、跟进后总结、当前状态、下一步建议和画像草稿提取
- `server/index.mjs`：HTTP API 与动作状态迁移

当前真实接入仍有一个明确边界：`X-Staff-Id` 只是当前内部联调身份头，不是生产登录认证。正式部署前需要接入手机号验证码、飞书身份或现有解忧小屋会话，并由服务端签发会话。

## 目录

```text
src/
  App.tsx          V0.4 页面、交互和演示工作流
  domain.ts        领域类型与权限相关数据结构
  data.ts          可替换的演示数据
  api.ts           页面使用的 API 边界
  clientApi.ts     本地 API / HTTP API 统一客户端
  repositories.ts  数据 Repository 边界与本地实现
  profile.ts       客户画像字段、自然语言本地兜底和展示分组
  styles.css       移动优先界面样式
server/
  index.mjs        ASVA HTTP 服务
  repository.mjs   飞书数据 Repository 与权限裁剪
  deepseek.mjs     DeepSeek 服务端调用
  feishu.mjs       飞书 token 和多维表 API 客户端
```

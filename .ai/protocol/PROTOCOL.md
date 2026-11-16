# AI 研发意图编译与验收协议（XSH AI Dev Protocol）V1.0

版本：`1.0.0` · 生效范围：本仓库的 AI 辅助研发协作 · 状态：首版候选，须经人类确认后在具体任务中采用

## 一、目标与非目标

**目标**：最大限度保留用户真实意图，减少多模型交接的信息丢失；将每项功能要求变成可测试的工程行为；确保执行结果真实、可追溯、可移交。**不是**保证任何模型 100% 理解、100% 一次成功或软件绝对无缺陷。

**非目标**：不规定使用哪个 AI 模型、不自动授权生产变更、不替代代码评审与真实业务验收、不让 YAML/JSON 自行决定安全或产品策略。

## 二、角色与权责

- **需求提出者（用户）**：以自然语言描述目的与期望体验；确认不可接受的行为、场景和验收标准；批准改变业务边界或生产操作。
- **需求编译者（ChatGPT 或指定 AI）**：澄清冲突，基于用户原话/仓库已核验事实编写 `task.yaml`；给每项需求 Rxxx、验收 ATxxx；标注未知和假设；不得擅自批准。
- **研发执行者（Grok Bot、Codex、Cursor、Claude Code 等）**：读取契约、核实真实代码/环境、按允许范围实现与测试；遇阻断返 `BLOCKED` 并给最小差异提案；生成 `result.json`，绝不自行宣布生产可用。
- **审核者（ChatGPT + 人类）**：逐项验事实和证据，区分“代码通过 / 集成通过 / UI通过 / 生产通过”，有未通过必选项则不给发布绿灯。

## 三、需求编译规则

1. **保真**：先写用户希望看到的具体行为，后写实现方案；明确输入、输出、触发条件、异常、性能、权限、数据映射、不可变约束和非目标。
2. **逆向确认**：将“我理解的效果 / 不会做什么 / 如何判定成功”交用户确认；`approval.user_confirmed=true` 必须有可追溯 `approval.reference`（GitHub讨论或批准消息引用），AI不得臆造。
3. **事实分级**：`project.verified_facts` 要列来源及核验日期；`project.assumptions` 不可当事实；快速变化的生产SHA、权限、云函数配置不能写成永久结论。
4. **双向映射**：每条 `must` 要求至少一个 `acceptance` 覆盖；每条验收必须标记 `requirement_ids` 和验证方法。一个 Mock 不覆盖需要真实接口的场景。
5. **禁做事项明确**：`scope.forbidden_paths`、`guardrails`、`authorization` 明确，生产写入/部署默认 `false`。没有真实授权，不能以“用户想要修好”为由操作生产。
6. **需求冻结**：一旦 `APPROVED`，更改既定行为、字段语义、存储、发布范围或安全规则必须升级 `spec_version` 并记录 `change_requests`，旧版本保留 Git 历史。

## 四、标准数据交换

**任务输入**：`task.yaml`，`protocol: XSH_AI_DEV_V1`、`kind: task`；方便人阅读但字段严格遵循 `schemas/task.schema.json`。YAML 经解析成为结构化对象后由 JSON Schema 检查。

**回执输出**：`result.json`，`protocol: XSH_AI_DEV_V1`、`kind: result`；包含 task ID+版本+源文件 SHA256、实际 commit SHA、逐项状态、证据、未完成项、部署动作、剩余风险和协议改进提案。

**任务状态**：`DRAFT → APPROVED → EXECUTING → VERIFIED`；任何阶段可进入 `BLOCKED`。执行者不能自行将任务审批为 `APPROVED`，审核者和用户才能判断 `VERIFIED`。

**回执状态**：`COMPLETE`（所有必选验收真实PASS）、`PARTIAL`（部分通过）、`BLOCKED`（关键依赖/授权缺失）。`NOT_TESTED` 和 `BLOCKED` 不等于 PASS。

## 五、证据与发布闸门

证据必须可复核，明确 `kind`（`commit` / `test_log` / `api_trace` / `external_readback` / `browser_e2e` / `screenshot` / `manual_check`）、`location`（仓库相对路径/CI产物/GitHub URL/脱敏凭据受控路径）、`summary` 和必要的真实 ID/时间/环境。空白引用不能算 PASS。

**不可作为真实验收的替代品**：仅 Mock PASS、HTTP请求已接受、AI返回200、某中间表存在、截图只显示旧缓存、执行者自己填写`ready_for_release: true`。

每次审阅依次核对：
- `task.yaml` 版本是否已批准，Git SHA 与被审代码是否一致；
- 全部 `release_blocking: true` 的验收是否 `PASS` 且证据真实；
- 数据原文、真实写回、前端回显、失败恢复、性能门槛是否分别得到验证；
- 没有越过 `authorization` 的生产/数据权限；
- 如需发布，必须再执行任务内明确的灰度/回滚计划，不能把研发完成当作部署完成。

## 六、执行与变更协议

开始：核对项目上下文和 GitHub 当前分支/代码/环境 → 验证契约 → 缺口报告或实施。执行期间只修改允许范围，代码附需求 ID，验收项逐一执行。发现阻断时返 `BLOCKED`，必须提供首个真实失败环节、原始错误码、已证实与未证实原因、最小建议和影响范围；**禁止未经同意改路线或跳过验收**。

**变更申请**：`change_requests` 包含 `id/reason/impact/proposal/status`，未批准前不能当作原需求覆盖。微小代码实现细节可由执行者决定，但不得改变业务规则、安全策略或数据定义。

**幂等**：一次任务以 task_id+spec_version+commit SHA 追踪；对数据写入必须单独使用业务 operationId 和实体幂等键，不能把任务ID当作所有记录的 client_token。

**隐私**：原始客户资料、手机号、秘钥和完整生产日志不得放入公开 GitHub；记录脱敏后的请求ID、环境标签、哈希、人工可访问的证据位置即可。

## 七、跨平台接管

新执行者只需：
1. 读取根目录 `AGENTS.md` 与 `.ai/README.md`。
2. 读取 `.ai/project/context.yaml`，对照实际代码验证易变事实。
3. 读取 `.ai/tasks/<ID>/task.yaml` 和最近的 `result.json`，沿 Github SHA/PR核对。
4. 运行 `python3 .ai/tools/validate.py result <task.yaml> <result.json>`。
5. **只续办 FAIL/BLOCKED/NOT_TESTED 项目**，不能把历史未通过项藏起来或重构已验证功能。

## 八、持续迭代

V1.0 是实验起点，不是永恒规则。每项完成后的回执可填 `improvement_proposals`（例如：新的真实失真案例、规则缺失、验收误判、成本与改善提案）。

每次调整遵循：**真实案例 → 复盘原因 → 新的协议测试/模板约束 → 人类审核 → 版本号升级 → CHANGELOG 记录 → 旧任务保留旧版**。
- PATCH：示例/措辞修订，不改变语义；
- MINOR：兼容新增字段或非强制规则；
- MAJOR：破坏兼容性的字段、状态或审批语义改变。
- 禁止由某一次模型运行未经批准自动改写协议本身。

## 九、操作原则

**尽可能高保真而非虚假的100%保证；最小完整闭环而非过度形式化；真实数据和可运行测试优先于漂亮报告；任何阻断都显式报告，绝不伪装完成。**
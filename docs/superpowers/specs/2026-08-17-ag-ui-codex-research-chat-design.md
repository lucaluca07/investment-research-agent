# AG-UI Codex 式投研聊天与设计系统规格

日期：2026-08-17  
状态：已完成方案评审，等待书面规格复核  
项目：`investment-research-agent`

## 0. 规格覆盖关系

本规格是《个人投研 Agent V1 设计规格》的专项修订。经批准后，本规格覆盖原规格第 3.6 节中“不实现 Adapter”以及原验收标准第 7 条中“不建设通用 Runtime 或 Adapter”的限制。

新增 Adapter 仅负责 Pi → AG-UI 协议转换和持久化客户端恢复，不实现或复制 Pi 的 Agent Loop。原规格关于 Python 单写者、生产工具白名单、研究资产权威性、人工审批、安全边界和聊天不得删除正式研究资产的要求继续有效。

## 1. 背景与目标

当前 V1a 已验证 Web、Chat Backend、Pi Session、Python Research Service、DuckDB 和 SSE 的垂直链路，但界面仍是功能性原型，自定义聊天协议也已暴露以下问题：

- 前后端事件字段容易漂移，曾因 delta 缺失 `run_id` 导致重复回复。
- UI 将消息、工具、引用和运行状态直接写入单个应用组件，难以扩展。
- 当前界面接近普通聊天页，不能呈现 Codex 式任务、过程更新和可审计产物。
- 缺少可复用设计系统、组件文档和视觉回归。

本次重构建立长期聊天基础设施，而不是仅修改 CSS。目标是：

1. 使用开放的 AG-UI 协议替换旧自定义聊天事件。
2. 使用 CopilotKit Headless 和自托管 Copilot Runtime 消费 Agent 状态，保留完全自主的视觉层。
3. 建立仓库内部 `packages/ui` 设计系统。
4. 将 V1a 重构为 Codex 式研究任务界面。
5. 保留 Pi Agent、Python Research Service、DuckDB、停止和断线恢复能力。

## 2. 范围与非目标

### 2.1 本次包含

- AG-UI Thread、Run、Message、Tool、State 和 Custom Event 契约。
- Pi Event → AG-UI Event 单一适配层。
- CopilotKit Headless 与自托管 Copilot Runtime。
- shadcn/ui、Tailwind CSS 4、CSS Variables 和 Lucide。
- 内部 `packages/ui` workspace。
- Storybook、组件状态、交互测试和视觉回归基础。
- 任务侧栏、聊天时间线、过程更新、工具、来源、产物卡、审批卡、Composer 和 Inspector。
- 新 AG-UI 数据库 Schema。
- 停止、刷新、重连、重放、原生 Interrupt/Resume 和幂等测试。

### 2.2 本次不包含

- 替换 Pi Agent Runtime。
- 替换 Python Research Service 或 DuckDB。
- 煤炭、有色等新 Research Pack。
- 每日雷达、行业驾驶舱、完整知识库等业务页面。
- 文件上传、图片输入或语音。
- npm 发布流程。
- 浅色主题。
- 移动端独立产品。

未实现能力必须隐藏或明确禁用，不得使用假数据伪装为可用功能。

## 3. 技术选型

### 3.1 协议：AG-UI

AG-UI 作为 Agent 与前端之间的规范协议，负责：

- 文本消息流。
- 工具调用与工具结果。
- Run 生命周期。
- 状态快照与增量。
- 中断和人工审批。
- 自定义投研事件。
- 未来的子 Agent 和 steering 扩展。

参考：

- https://docs.ag-ui.com/
- https://docs.ag-ui.com/concepts/architecture

### 3.2 前端 Runtime：CopilotKit Headless

CopilotKit Headless 负责消费 AG-UI、维护运行状态和提供 Agent 交互能力。视觉组件由内部设计系统实现，不采用完整的预制聊天外观。

前端通过 CopilotKit Runtime-backed 路径连接 Agent。仓库自托管 Copilot Runtime，由 Runtime 注册指向 Fastify AG-UI Endpoint 的 Agent；不使用 Enterprise `selfManagedAgents`，也不使用 `agents__unsafe_dev_only`。

首个实现版本固定使用 `@copilotkit/* = 1.68.1`，并遵循其锁定的 `@ag-ui/* = 0.0.57`，不得分别追随 latest。升级必须先通过 Interrupt/Resume 兼容性契约测试。

Copilot Runtime 负责 CopilotKit 标准 Agent 发现、请求代理和 AG-UI 流传递；Fastify 继续负责 Pi Session、协议适配、持久化恢复和业务安全边界。Runtime 不保存第二份权威消息或研究状态。

Runtime 注册一个服务端 `PersistentResearchAgent extends AbstractAgent`。其实现严格遵循锁定 SDK 的 `protected run(input)`、可选 `protected connect(input)`、`abortRun()` 和 `getCapabilities()` 契约：新 Run 代理到 Fastify 标准 AG-UI 执行端点；连接恢复从 Fastify Snapshot/Cursor 接口重建事件流。该 Agent 只做传输和恢复，不折叠或另存消息。

参考：https://docs.copilotkit.ai/

### 3.3 基础组件：shadcn/ui

shadcn/ui 作为源码分发基础，组件进入 `packages/ui` 并由本仓库维护。使用 Tailwind CSS 4、CSS Variables、OKLCH 语义色和 Lucide 图标。

参考：

- https://ui.shadcn.com/docs/monorepo
- https://ui.shadcn.com/docs/theming

### 3.4 保留组件

- Pi：模型会话和研究工具循环。
- Fastify Chat Backend：协议适配、会话控制和流式出口。
- Python Research Service：DuckDB 唯一写入者。
- DuckDB：Thread、Run、Event、Snapshot、Tool Operation、Agent Checkpoint、Evidence、Artifact 和 Approval。

## 4. 总体架构

```text
Web / CopilotKit Headless
        │ CopilotKit v2
        ▼
Self-hosted Copilot Runtime
        │ AG-UI
        ▼
Fastify Chat Backend
        │
        ├── Pi Adapter ── Pi Session / Research Tools
        │
        └── Research Client
                 │ HTTP
                 ▼
Python Research Service ── DuckDB
```

服务端只有一个模型事件转换边界：`Pi Adapter → AG-UI Events`。Copilot Runtime 只代理标准事件，不重新定义消息模型。前端、持久化和测试均以 AG-UI 为准，不保留第二套旧聊天事件模型。

## 5. AG-UI 数据流

### 5.1 发送与执行

1. 用户在 Composer 发送问题。
2. CopilotKit Headless 创建 Thread Run 请求。
3. Chat Backend 校验 Message ID 和客户端幂等键，在单个 Python 事务中创建 Run、持久化包含规范化 input 的 `RUN_STARTED`，并追加包含新用户消息的 `MESSAGES_SNAPSHOT`。
4. Chat Backend 创建或恢复对应 Pi Session。
5. Pi Adapter 将 Pi 输出转换为 AG-UI 标准事件。
6. 关键事件立即写入 Research Service；文本增量由 Event Batcher 合并后批量写入。
7. 已持久化事件再经 Copilot Runtime 对浏览器广播；消息结束前强制刷新待写文本批次。
8. 前端根据稳定 ID 更新同一个 UI Message。
9. Run 完成后按策略生成可重建的 Message Snapshot 检查点。

相同客户端幂等键的重复请求返回原 Run ID 和已有事件位置，不重复创建 Run，也不再次追加用户消息。

### 5.2 Pi 事件映射

最低映射要求：

```text
Pi text start/delta/end  → AG-UI text message events
Pi tool start            → TOOL_CALL_START
Pi tool arguments        → TOOL_CALL_ARGS
Pi tool arguments end    → TOOL_CALL_END
Pi tool result           → TOOL_CALL_RESULT
Run lifecycle            → RUN_STARTED / RUN_FINISHED / RUN_ERROR
Research progress        → STEP_STARTED / STEP_FINISHED 或 ACTIVITY 事件
Evidence                 → CUSTOM evidence event
Artifact                 → CUSTOM artifact event
Approval                 → RUN_FINISHED interrupt outcome + resume input
```

具体事件名和字段以锁定的 AG-UI SDK 版本为准，不在业务代码中重新定义同名平行类型。

### 5.3 ID 与顺序约束

- Thread ID、Run ID、Message ID、Tool Call ID 分别稳定。
- 同一消息的 start/content/end 使用相同 Message ID。
- 每个持久化事件包含单调递增序号。
- 相同事件重复消费必须幂等。
- 非法状态转换必须在 Adapter 或 Research Service 边界失败。
- 完成快照不能生成第二条语义相同的 Assistant Message。

### 5.4 恢复和停止

本地应用不采用需要 Redis 的默认可恢复流方案。网络恢复能力由现有持久化层提供：

- `GET /v1/threads/:threadId/state` 返回最新 Snapshot、`last_event_seq` 和 active Run。
- `POST /v1/threads/:threadId/runs` 创建新 Run，并要求客户端幂等键。
- `GET /v1/threads/:threadId/events?after=:sequence` 回放缺失事件并进入实时订阅。
- 完整刷新先加载 Snapshot，再从 `last_event_seq` 继续消费事件。
- 事件端点先注册实时订阅，再读取历史事件，合并订阅期间产生的 pending 事件，最后进入实时模式。
- sequence 在单个 Thread 内严格递增，前端用 `thread_id + sequence` 去重。
- V1 不压缩 `agui_events`；只有 Schema 不兼容或开发数据库被显式重置时返回 `410 Gone`，客户端重新加载完整 Snapshot。
- 网络断线只补发缺失事件，不重新执行 Agent，也不终止仍在运行的 Pi Session。
- 用户停止通过显式 Agent Control 命令调用 Pi abort；Fastify 随后输出 `RUN_ERROR { code: "run_cancelled" }`，数据库 Run 状态记为 `cancelled`，UI 将该错误码中性显示为“已停止”。
- Stop 不依赖关闭浏览器流，因此可与恢复能力同时存在。
- Runtime Agent 仅在上述恢复契约真实可用时声明 transport resumable capability。

Run 状态固定为：

`pending → running → completed | interrupted | failed | cancelled`

`interrupted` 是终态。用户决定后创建新 Run，通过 AG-UI `resume` 关联全部开放 Interrupt，并记录 `resumed_from_run_id`；原 Run 不得重新进入 `running`。服务重启不改变这一语义，因为审批时原 Run 已经结束。

本规格同时扩展原 `ResearchRunStep` 状态机，增加终态 `interrupted`。产生审批中断时，原 Run Step 从 `waiting_approval` 进入 `interrupted`；恢复 Run 创建带 `resumed_from_step_id` 的新 Step 执行决定。Tool Operation 跨越两个 Run/Step，作为副作用连续性的权威对象，禁止让原终态 Step 回到 `running`。

### 5.5 事件批量持久化

- Run、Tool、Approval、State Snapshot、Message Snapshot 和 Message End 立即持久化。
- 连续 Text Message Content 由 Fastify 按不超过 50ms 或 2KB 的阈值合并，以先达到者为准。
- Research Service 提供批量追加接口，并在单个 DuckDB 事务中分配连续 Thread sequence。
- 同一 Thread 的事件必须经过串行写入队列；任意非 Text Message Content 事件到达前，先 flush 当前 Message 的待写文本批次。
- Message End、Run Finished、Run Error、Abort 和进程正常退出前必须强制 flush。
- 广播只能发生在对应批次持久化成功后；持久化失败不得向 UI 暴露未保存事件。

## 6. 数据模型与不兼容迁移

### 6.1 新持久化对象

- `threads`：Thread 元数据、标题来源和手动标题锁定状态。
- `runs`：Run 状态、幂等键和恢复关系。
- `agui_events`：不可变的聊天和运行权威日志。
- `tool_calls`：AG-UI Tool Call 协议、展示和审计记录，不作为副作用执行权威。
- `tool_operations`：受审批副作用的输入、幂等键、决定和执行状态。
- `agent_checkpoints`：Interrupt 边界上的 Pi Session 与协议恢复指针。
- `resume_receipts`：Interrupt 响应的规范化内容和幂等结果。
- `message_snapshots`：从事件折叠得到的可重建检查点。

不新增聊天层 `thread_messages`、`evidence`、`artifacts` 或第二套 `approval_requests`。Evidence、Artifact 和 Approval 继续使用研究内核领域表；AG-UI 事件只保存领域对象 ID、版本和生成当时的最小 UI 投影。

权威关系固定为：

- `agui_events` 是对话和 Run 重放的唯一权威来源。
- `message_snapshots` 是派生缓存，保存 `thread_id`、`last_event_seq`、`messages_json`、`agent_state_json`、`schema_version` 和创建时间。
- Snapshot 可由事件重建，不能独立修改聊天事实。
- 研究内核表是 Evidence、Artifact、Approval 及其他正式研究资产的唯一权威来源。
- `tool_operations` 是受审批副作用是否已经执行的唯一权威来源，Approval 只记录用户决定。
- `agent_checkpoints` 是 Pi 恢复位置的权威来源；AG-UI Snapshot 只恢复协议和 UI 状态。
- 删除、压缩或分叉 Thread 不得级联删除已确认的研究资产。

正式 Schema 名可根据现有数据库命名规范调整，但上述职责和权威关系不得改变。

### 6.2 本地安全边界

- V1a 的 Web、Copilot Runtime、Fastify 和 Python Research Service 只监听 `127.0.0.1`。
- 浏览器通过 Vite 同源代理分别访问 Copilot Runtime 和 Fastify Thread/Artifact 控制面，不开放任意 Origin CORS；Agent Run 只经过 Runtime。
- Interrupt response 包含一次性随机 nonce；Research Service 校验 `approval_id + nonce`、当前 pending 状态和响应 Schema。
- 重复的相同决定按幂等结果返回；相互冲突的后续决定返回 `409 Conflict`。
- 未来开放远程访问前，必须另行设计身份认证、用户隔离、CSRF 防护和密钥管理。

### 6.3 开发期数据重置

用户已确认不保留当前 V1a 本地聊天数据。

- 新 Schema 通过显式开发迁移命令初始化。
- 普通启动脚本不得静默删除数据库。
- 检测到旧 Schema 时，启动失败并提供明确的重置命令。
- 重置命令必须验证目标是项目运行目录中的开发数据库。
- Pi Session 运行目录、测试 fixture 和数据库分别处理，不使用宽泛递归删除。

### 6.4 旧协议移除

迁移完成后删除：

- 自定义 `message.delta`、`message.completed` 等事件判断。
- 手工消息拼接和临时 `stream-current` 逻辑。
- 旧 `ChatApi.subscribe` EventSource 状态机。
- 与新 AG-UI Schema 重复的旧表和模型。

禁止长期双写两套协议。

## 7. `packages/ui` 设计系统

### 7.1 目录

```text
packages/ui/
├── components.json
├── package.json
├── src/
│   ├── primitives/
│   ├── chat/
│   ├── research/
│   ├── layout/
│   ├── tokens/
│   ├── styles/
│   ├── icons/
│   └── index.ts
└── stories/
```

### 7.2 shadcn 基础组件

优先引入：

- Button、Textarea、Tooltip、Badge
- Dialog、Popover、DropdownMenu
- ScrollArea、Tabs、Collapsible
- Sheet、Command、Skeleton
- Separator、Toast、Resizable

基础组件不包含 PCB、公司或研究业务逻辑。

### 7.3 Agent 聊天组件

- `ThreadList`
- `Conversation`
- `UserMessage`
- `AssistantMessage`
- `ActivityGroup`
- `ToolCall`
- `SourceCitation`
- `ArtifactCard`
- `ApprovalCard`
- `Composer`
- `StreamingIndicator`
- `ErrorNotice`

这些组件依赖 AG-UI/CopilotKit 状态，不依赖旧自定义事件。

### 7.4 投研领域组件

- `SecurityTag`
- `EvidenceCard`
- `EvidenceQuality`
- `MetricValue`
- `DataFreshness`
- `ResearchStatus`
- `ThesisCard`
- `CatalystCard`
- `ResearchArtifact`
- `ReportVersion`

V1a 只实现聊天真实使用的组件。未接通业务能力的组件可以定义类型和 Storybook 状态，但不能进入产品导航形成假入口。

### 7.5 视觉 Token

- 默认深色专业终端主题。
- 深灰蓝背景，不使用纯黑。
- 三层表面层级，减少无意义边框。
- 正文、弱信息、禁用信息满足明确对比度。
- 成功、运行、警告、错误、证据和审批使用低饱和语义色。
- 数字使用等宽数字特性。
- 中文正文保持适合长阅读的行高。
- 圆角克制，避免所有内容都成为大卡片。
- 动效仅用于流式状态、展开收起和 Inspector。
- 应用层不得直接硬编码主题颜色。

## 8. Codex 式任务界面

### 8.1 页面框架

采用：

> 左侧任务栏 + 中间对话主区 + 按需 Inspector

Inspector 默认关闭，不使用固定三栏。

### 8.2 任务侧栏

包含：

- 产品名称和运行状态。
- 新建研究任务。
- 搜索任务。
- 收起侧栏。
- Thread 标题、关联标的、更新时间和运行状态。

标题策略：

1. V1a 创建时使用用户第一句话确定性截断。
2. 用户可以手动修改标题；修改后记录 `title_source = manual`。
3. Agent 自动标题延后到后续版本，不属于本次验收。

### 8.3 对话时间线

- 用户消息使用克制气泡。
- Agent 最终回答直接排版，不使用巨大白色卡片。
- 连续进度事件合并为可折叠 `ActivityGroup`。
- 工具显示名称、状态、耗时和错误摘要。
- 来源使用紧凑引用，点击打开 Inspector。
- 长报告只显示 Artifact 卡片。
- 流式与完成状态共享同一 Message ID。

过程更新展示可验证动作，不展示不可审计的原始思维链。

### 8.4 Inspector

以下动作打开 Inspector：

- 点击引用：证据、来源、日期、定位和可信等级。
- 点击 Artifact：预览、版本和保存状态。
- 点击工具：参数、结果、耗时和错误。
- 点击审批：依据、影响范围、确认和拒绝。

Inspector 可调整宽度，并可进入独立阅读页。

### 8.5 Composer

包含：

- 多行输入。
- 研究模式标识。
- 模型和连接状态。
- 发送/停止按钮。
- 快捷键提示。

附件能力在真实实现前隐藏。V1a 同一 Thread 同时只允许一个主动 Run；运行期间禁用发送，只保留停止。消息排队与 steering 延后到后续版本。

### 8.6 响应式

- 宽屏：侧栏与对话并列，Inspector 按需出现。
- 中等宽度：侧栏可折叠，Inspector 覆盖显示。
- 窄屏：任务和 Inspector 使用 Sheet。
- V1a 以桌面端验收为主。

## 9. Artifact、Evidence 与 Approval

### 9.1 Artifact

完整报告不铺满聊天。聊天只显示标题、摘要、类型、版本和打开入口。Artifact 可以在 Inspector 或独立页面阅读，并在后续接入知识库。

### 9.2 Evidence

证据至少包含：

- 来源标题和 URL/文档 ID。
- 发布日期和适用日期。
- 原文定位。
- 可信等级。
- 支持或反驳方向。

### 9.3 Approval

以下操作未来需要审批：

- 保存正式研究产物。
- 加入持续追踪池。
- 激活、反转或关闭投资论点。
- 修改关键失效条件。

V1a 只将现有 `save_research_note` 接入真实审批链路；其他审批仅定义协议与组件状态。

`save_research_note` 使用 AG-UI 原生 Interrupt/Resume，不保留长期存活的 Promise：

1. Pi 发起工具调用并产生稳定 `tool_call_id`。
2. Fastify 调用 Python Research Service，原子创建 Approval、Tool Operation 和 `waiting_approval` Run Step，但不执行正式写入。
3. Pi Adapter 输出恢复所需的 `STATE_SNAPSHOT` 和 `MESSAGES_SNAPSHOT`；Research Service 持久化 Agent Checkpoint，并将原 Run Step 从 `waiting_approval` 终结为 `interrupted`。
4. 当前 Run 输出 `RUN_FINISHED`，其 `outcome.type = interrupt`；Interrupt 使用 `reason = tool_call`、关联原 `tool_call_id`，并声明审批响应 Schema。
5. 用户决定后，前端创建新 Run；`RunAgentInput.resume` 使用同一 Thread 并覆盖全部开放 Interrupt。批准和拒绝均使用 `status = resolved`，在 payload 中以 `approved` 区分；放弃才使用 `status = cancelled`。
6. Fastify 只能调用 Research Service 的单一 `resolve_interrupt` 命令；该命令在一个事务中校验 Interrupt、nonce 和响应 Schema，写入 Approval decision、迁移 Tool Operation、保存 Resume Receipt，并返回规范化恢复输入。
7. 新 Run 先由确定性恢复控制器处理 Tool Operation：批准则按原幂等键执行，拒绝或取消则不写入。
8. 新 Run 针对原 `tool_call_id` 输出 `TOOL_CALL_RESULT`，不重新输出同一工具的 Start/Args/End。
9. Pi Session 接收结构化 Tool Result 后继续后续 Turn。

Approval 记录用户决定；Tool Operation 记录副作用执行状态。状态机固定为：

`proposed → waiting_approval → approved → executing → succeeded | failed`

`waiting_approval → rejected | cancelled`

恢复控制器规则：

- `approved`：进入 `executing` 并执行写入。
- `executing`：先查询幂等键和已有结果；状态不确定时停止自动执行并要求人工核对。
- `succeeded`：返回原结果引用，不重复写入。
- `rejected` 或 `cancelled`：返回结构化 Tool Result，永不执行正式写入。
- 重复 resume 必须以 `thread_id + interrupt_id + status + payload_hash` 幂等。

审批可以等待任意时长，页面刷新和所有服务重启都不会改变恢复流程。存在开放 Interrupt 时，不接受普通新消息；请求必须携带覆盖全部开放 Interrupt 的 `resume`。

Agent Checkpoint 至少保存：

- `checkpoint_id`、`thread_id` 和 `interrupted_run_id`。
- `pi_session_id`、`pi_session_revision` 和经过验证的 Session 存储位置引用。
- 原 `tool_call_id`、`tool_operation_id` 和 Pi 内部 Tool Call ID 映射。
- `messages_last_event_seq`、`state_snapshot_event_seq` 和创建时间。

恢复顺序固定为：读取并校验 Agent Checkpoint → 调用 `resolve_interrupt` → 处理 Tool Operation → 恢复 Pi Session → 验证原 Tool Call → 注入结构化 Tool Result → 启动后续 Turn。若 Pi Session 缺失、损坏或版本不兼容，系统创建标记为 `recovery_fallback` 的新 Turn，将原消息、Tool Call、用户决定和确定性执行结果作为结构化上下文注入；不得宣称恢复了原 Pi Turn，也不得重新执行已完成副作用。

## 10. 错误处理

- 连接错误：自动重连并从事件序号恢复。
- 模型错误：保留已完成过程，以新 Run 重试。
- 工具错误：局部显示失败，保留已有证据。
- 持久化错误：停止广播，避免显示未保存结果。
- 协议错误：拒绝非法 AG-UI 事件并记录 Adapter 错误。
- 渲染错误：Tool、Evidence、Artifact 使用局部 Error Boundary。
- 用户停止：仍在运行的 Run 标记 cancelled，保留停止前内容并输出 `RUN_ERROR { code: "run_cancelled" }`。
- 审批等待：原 Run 已是 interrupted 终态；用户放弃通过 `resume.status = cancelled` 创建收尾 Run，不执行正式写入。
- 审批恢复：所有恢复都通过新 Run 和持久化 Tool Operation 完成，不依赖内存 tool call。

## 11. 测试策略

### 11.1 协议契约

- Pi 事件转换为合法 AG-UI 事件。
- ID 一致性和状态顺序。
- 未知或非法事件快速失败。
- 固定版本的 Copilot Runtime 能发现 Research Agent。
- `RUN_FINISHED.outcome.interrupts` 能完整穿透 Runtime。
- CopilotKit `useInterrupt` 产生符合 Schema 的完整 `resume[]`。
- 恢复 Run 能针对原 Tool Call 输出 Result，而不重复 Start/Args/End。

### 11.2 Reducer 与幂等

- 重复事件。
- 乱序事件。
- 断线重放。
- Snapshot 与增量合并。
- 完成消息唯一性。
- 文本批次与 Tool、Approval、State 等关键事件的跨批次顺序。
- 重复 Run 请求不重复追加用户消息。

### 11.3 组件与 Storybook

核心组件至少包含：

- Default
- Loading
- Streaming
- Empty
- Error
- Long content
- Keyboard interaction
- Narrow viewport

执行组件交互、可访问性、视觉快照和公共 TypeScript API 检查。

### 11.4 集成与 E2E

集成链路：

```text
CopilotKit Headless
→ Copilot Runtime
→ Chat Backend
→ Fake Pi Session
→ Research Service
→ DuckDB
```

浏览器 E2E 覆盖：

- 新建和切换任务。
- 发送与流式回复。
- 工具过程与来源。
- 停止。
- 刷新恢复。
- 原生 Interrupt、刷新后批准、拒绝、取消和全服务重启恢复。
- Pi Session 损坏时的 `recovery_fallback`，且副作用不重复执行。
- 打开 Inspector。
- 错误降级。
- 同一回复只渲染一次。

## 12. 验收标准

1. 前端不再包含旧自定义 SSE 事件判断。
2. Pi Adapter 输出通过 AG-UI Schema 校验。
3. 同一回复在重放、重连和快照合并后只显示一次。
4. 停止、刷新恢复和历史加载均可工作。
5. 用户可看到 Codex 式进度、工具状态和最终回答。
6. 引用和 Artifact 从聊天打开 Inspector。
7. 任务标题由首条用户消息确定性生成，且用户可以手动修改。
8. 应用基础组件来自 `packages/ui`。
9. 核心组件具有 Storybook 状态和视觉回归。
10. 未实现模块不使用假数据或伪交互。
11. `save_research_note` 在批准前不产生正式研究资产，原 Run 以标准 interrupt outcome 结束。
12. 审批决定通过新 Run 的标准 resume 输入提交，续接 Run 关联原 Run 和原 Tool Call。
13. 所有服务重启后 pending Approval 仍可决定，Tool Operation 保持幂等且不会重复写入。
14. 审批取消后 Tool Operation 进入 cancelled，之后提交其他决定返回冲突且不会执行正式写入。
15. Run 创建事务将用户消息写入权威事件日志，重复幂等请求不会产生第二条消息。
16. Stop 以 `RUN_ERROR code=run_cancelled` 收口，UI 显示“已停止”而非普通错误。
17. 正常恢复与 Pi Session 损坏降级恢复均通过自动化测试，且不会重复执行副作用。

## 13. 实施拆分

本规格分为三个连续阶段，每阶段独立验收：

### 阶段一：AG-UI 协议与数据模型

- 锁定依赖版本。
- 建立事件契约和 Pi Adapter。
- 新建持久化 Schema 和显式重置命令。
- 建立自托管 Copilot Runtime 和 Fastify AG-UI Agent Endpoint。
- 实现 Event Batcher、Agent Checkpoint、`resolve_interrupt`、恢复端点和 capabilities。
- 完成恢复、停止、Interrupt/Resume、重放和幂等测试。

### 阶段二：设计系统

- 建立 `packages/ui`。
- 初始化 shadcn、Tailwind 和主题 Token。
- 建立 Storybook。
- 实现基础聊天与投研组件。

### 阶段三：Codex 式聊天界面

- 接入 CopilotKit Headless。
- 重构任务侧栏、时间线、Composer 和 Inspector。
- 删除旧 Web Chat 状态机。
- 完成浏览器 E2E 和视觉回归。

不得将三个阶段压缩为一个不可审阅的大提交。

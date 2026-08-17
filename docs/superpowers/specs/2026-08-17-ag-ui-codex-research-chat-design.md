# AG-UI Codex 式投研聊天与设计系统规格

日期：2026-08-17  
状态：已完成方案评审，等待书面规格复核  
项目：`investment-research-agent`

## 1. 背景与目标

当前 V1a 已验证 Web、Chat Backend、Pi Session、Python Research Service、DuckDB 和 SSE 的垂直链路，但界面仍是功能性原型，自定义聊天协议也已暴露以下问题：

- 前后端事件字段容易漂移，曾因 delta 缺失 `run_id` 导致重复回复。
- UI 将消息、工具、引用和运行状态直接写入单个应用组件，难以扩展。
- 当前界面接近普通聊天页，不能呈现 Codex 式任务、过程更新和可审计产物。
- 缺少可复用设计系统、组件文档和视觉回归。

本次重构建立长期聊天基础设施，而不是仅修改 CSS。目标是：

1. 使用开放的 AG-UI 协议替换旧自定义聊天事件。
2. 使用 CopilotKit Headless 消费 Agent 状态，保留完全自主的视觉层。
3. 建立仓库内部 `packages/ui` 设计系统。
4. 将 V1a 重构为 Codex 式研究任务界面。
5. 保留 Pi Agent、Python Research Service、DuckDB、停止和断线恢复能力。

## 2. 范围与非目标

### 2.1 本次包含

- AG-UI Thread、Run、Message、Tool、State 和 Custom Event 契约。
- Pi Event → AG-UI Event 单一适配层。
- CopilotKit Headless 前端 Runtime。
- shadcn/ui、Tailwind CSS 4、CSS Variables 和 Lucide。
- 内部 `packages/ui` workspace。
- Storybook、组件状态、交互测试和视觉回归基础。
- 任务侧栏、聊天时间线、过程更新、工具、来源、产物卡、审批卡、Composer 和 Inspector。
- 新 AG-UI 数据库 Schema。
- 停止、刷新、重连、重放和幂等测试。

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
- DuckDB：Thread、Run、Event、Message、Evidence、Artifact 和 Approval。

## 4. 总体架构

```text
Web / CopilotKit Headless
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

系统只有一个协议转换边界：`Pi Adapter → AG-UI Events`。前端、持久化和测试均以 AG-UI 为准，不保留第二套旧聊天事件模型。

## 5. AG-UI 数据流

### 5.1 发送与执行

1. 用户在 Composer 发送问题。
2. CopilotKit Headless 创建 Thread Run 请求。
3. Chat Backend 先持久化用户 UI Message 和 Run。
4. Chat Backend 创建或恢复对应 Pi Session。
5. Pi Adapter 将 Pi 输出转换为 AG-UI 标准事件。
6. 每个事件先写入 Research Service，再对浏览器广播。
7. 前端根据稳定 ID 更新同一个 UI Message。
8. Run 完成后保存完整 Message Snapshot。

### 5.2 Pi 事件映射

最低映射要求：

```text
Pi text start/delta/end  → AG-UI text message events
Pi tool start            → TOOL_CALL_START
Pi tool arguments        → TOOL_CALL_ARGS
Pi tool result           → TOOL_CALL_RESULT / TOOL_CALL_END
Run lifecycle            → RUN_STARTED / RUN_FINISHED / RUN_ERROR
Research progress        → CUSTOM research-status event
Evidence                 → CUSTOM evidence event
Artifact                 → CUSTOM artifact event
Approval                 → interrupt/state event
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

本地应用不采用需要 Redis 的默认可恢复流方案。恢复能力由现有持久化层提供：

- 完整刷新先加载 Message Snapshot。
- 活跃 Run 继续订阅最后事件序号之后的事件。
- 网络断线只补发缺失事件，不重新执行 Agent。
- 用户停止通过显式 Agent Control 命令调用 Pi abort。
- Stop 不依赖关闭浏览器流，因此可与恢复能力同时存在。

## 6. 数据模型与不兼容迁移

### 6.1 新持久化对象

- `threads`
- `thread_messages`
- `runs`
- `agui_events`
- `tool_calls`
- `message_snapshots`
- `evidence`
- `artifacts`
- `approval_requests`

正式 Schema 名可根据现有数据库命名规范调整，但对象职责不得合并为不可审计的 JSON 大表。

### 6.2 开发期数据重置

用户已确认不保留当前 V1a 本地聊天数据。

- 新 Schema 通过显式开发迁移命令初始化。
- 普通启动脚本不得静默删除数据库。
- 检测到旧 Schema 时，启动失败并提供明确的重置命令。
- 重置命令必须验证目标是项目运行目录中的开发数据库。
- Pi Session 运行目录、测试 fixture 和数据库分别处理，不使用宽泛递归删除。

### 6.3 旧协议移除

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

1. 创建时使用用户第一句话截断。
2. 首次回答完成后允许 Agent 生成短标题。
3. 用户手动修改后不得被自动覆盖。

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

附件能力在真实实现前隐藏。Agent 运行时的新输入进入下一轮队列，不静默打断当前 Run。

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

## 10. 错误处理

- 连接错误：自动重连并从事件序号恢复。
- 模型错误：保留已完成过程，以新 Run 重试。
- 工具错误：局部显示失败，保留已有证据。
- 持久化错误：停止广播，避免显示未保存结果。
- 协议错误：拒绝非法 AG-UI 事件并记录 Adapter 错误。
- 渲染错误：Tool、Evidence、Artifact 使用局部 Error Boundary。
- 用户停止：Run 标记 cancelled，保留停止前内容。

## 11. 测试策略

### 11.1 协议契约

- Pi 事件转换为合法 AG-UI 事件。
- ID 一致性和状态顺序。
- 未知或非法事件快速失败。

### 11.2 Reducer 与幂等

- 重复事件。
- 乱序事件。
- 断线重放。
- Snapshot 与增量合并。
- 完成消息唯一性。

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
7. 任务标题可自动生成且不覆盖手动标题。
8. 应用基础组件来自 `packages/ui`。
9. 核心组件具有 Storybook 状态和视觉回归。
10. 未实现模块不使用假数据或伪交互。

## 13. 实施拆分

本规格分为三个连续阶段，每阶段独立验收：

### 阶段一：AG-UI 协议与数据模型

- 锁定依赖版本。
- 建立事件契约和 Pi Adapter。
- 新建持久化 Schema 和显式重置命令。
- 完成恢复、停止、重放和幂等测试。

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

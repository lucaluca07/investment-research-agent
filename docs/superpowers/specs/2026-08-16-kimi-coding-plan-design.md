# Kimi Coding Plan 模型配置设计

## 目标

将投资研究 Agent 的生产模型固定为 Kimi Coding Plan。除 API Key 外，provider、接口、模型能力和推理等级全部由应用内置，避免运行环境出现模型配置漂移。

## 固定配置

- Provider ID：`kimi-coding-plan`
- Base URL：`https://api.kimi.com/coding/v1`
- API：`openai-completions`
- Model ID：`k3-256k`
- Context window：`262144`
- 输入：文本和图片
- Reasoning：启用，默认等级 `high`
- Kimi 工具兼容：`deferredToolsMode: "kimi"`
- API Key：仅从 `KIMI_API_KEY` 读取

应用不再使用 `IRA_PI_PROVIDER`、`IRA_PI_MODEL` 或 `IRA_PI_API_KEY` 选择模型。`IRA_RUNTIME_DIR` 和 `IRA_RESEARCH_SERVICE_URL` 仍保留，因为它们属于运行环境配置，而非模型选择。

## 架构

`createResearchSession()` 继续为每个 pi session 创建独立的 `cwd`、`agentDir`、session 文件目录、credential 路径和 model 配置路径。在创建 `ModelRuntime` 前，应用向该 session 的 `models.json` 写入固定 Kimi provider/model 描述；文件只引用环境变量名或完全不包含凭证，绝不写入 API Key。

随后应用通过 `ModelRuntime.setRuntimeApiKey("kimi-coding-plan", process.env.KIMI_API_KEY)` 注入临时凭证，并显式选择 `kimi-coding-plan/k3-256k`。`createAgentSession()` 接收 `thinkingLevel: "high"`。

资源隔离策略保持不变：禁用 pi 默认编码工具、扩展、skills、prompt templates、themes、context files 和项目配置发现，只注册现有两个研究工具。

## 配置与错误处理

`KIMI_API_KEY` 缺失、为空白或 provider/model 未能加载时，session 创建立即失败，并返回不包含凭证内容的明确错误。API Key 只存在于进程环境和 `ModelRuntime` 的 runtime override 中，不进入日志、DuckDB、SSE、浏览器响应或 session 文件。

模型配置文件采用原子写入或确定性覆盖，保证同一 session 重启时配置一致。不同 session 仍使用不同 `agentDir`，不会共享 auth、models 或 session 状态。

## Kimi 兼容映射

Harness 的 `chat_completions` 映射为 pi 的 `openai-completions`。`context_length` 映射为 `contextWindow`；`supports_vision` 映射为 `input: ["text", "image"]`；`reasoning_effort: high` 通过 session 的 `thinkingLevel: "high"` 表达。模型同时声明 `reasoning: true` 和 Kimi deferred tools compatibility。

当前 Web 客户端仍仅支持文本输入。本次只声明底层模型具备图片能力，不新增上传、存储或视觉消息 UI。

## 测试

测试优先覆盖：

- 缺少 `KIMI_API_KEY` 时创建失败且错误不泄露凭证。
- session 的 `models.json` 包含固定 provider、base URL、API、model、上下文和视觉能力。
- runtime API Key 注入目标固定为 `kimi-coding-plan`。
- 模型选择固定为 `k3-256k`。
- `createAgentSession()` 使用 `thinkingLevel: "high"`。
- 两个研究工具、默认编码工具禁用和 session 目录隔离不回归。
- 全量 TypeScript、Python 和真实 HTTP E2E 验证继续通过；E2E 不调用付费 Kimi API。

## 非目标

- 不支持运行时切换 provider/model。
- 不安装或加载 Kimi pi 扩展。
- 不复用用户全局 `~/.pi` 登录状态。
- 不实现图片上传或视觉聊天 UI。
- 不将 API Key 写入仓库或任何配置文件。

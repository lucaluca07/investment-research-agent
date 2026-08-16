# OpenAI-Compatible 模型配置设计

## 目标

投资研究 Agent 固定使用 pi，不增加可插拔 Agent 抽象。模型传输层支持一个由环境变量描述的 OpenAI Chat Completions 兼容接口；Kimi Coding Plan 是当前默认 profile，但不是业务代码依赖。

## 配置边界

- pi API 固定为 `openai-completions`。
- Agent 框架、system prompt、session 生命周期和两个研究工具保持固定。
- Base URL、model ID、context window、reasoning level 和视觉能力有内置 Kimi 默认值，并允许在服务启动时通过环境变量覆盖。
- Compatibility profile 只处理不同 OpenAI-compatible 服务的协议差异，不改变 Agent 行为。
- API Key 仅从环境读取。

模型环境变量为：

- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_CONTEXT_LENGTH`
- `LLM_REASONING_EFFORT`
- `LLM_SUPPORTS_VISION`
- `LLM_COMPAT_PROFILE`

当前使用 Kimi 默认值时只需要提供 `KIMI_API_KEY`；`LLM_API_KEY` 是切换其他 OpenAI-compatible endpoint 时使用的通用入口，并具有更高优先级。其余 `LLM_*` 变量都是可选覆盖项。`IRA_RUNTIME_DIR` 和 `IRA_RESEARCH_SERVICE_URL` 继续保留。旧的 `IRA_PI_PROVIDER`、`IRA_PI_MODEL` 和 `IRA_PI_API_KEY` 不再作为模型配置入口。

## 架构

`createResearchSession()` 继续为每个 pi session 创建独立的 `cwd`、`agentDir`、session 文件目录、credential 路径和 model 配置路径。在创建 `ModelRuntime` 前，应用根据经过校验的环境变量生成该 session 的 `models.json`；文件不包含 API Key。

应用使用内部固定 provider ID（例如 `openai-compatible`），通过 `ModelRuntime.setRuntimeApiKey()` 注入临时凭证，并显式选择配置的 model ID。`createAgentSession()` 接收经过校验的 reasoning level。

资源隔离策略保持不变：禁用 pi 默认编码工具、扩展、skills、prompt templates、themes、context files 和项目配置发现，只注册现有两个研究工具。

## 配置与错误处理

API Key 缺失、覆盖值非法或 model 未能加载时，session 创建立即失败，并返回不包含凭证内容的明确错误。API Key 解析顺序为 `LLM_API_KEY`，然后在 `kimi` profile 下回退到 `KIMI_API_KEY`。API Key 只存在于进程环境和 `ModelRuntime` 的 runtime override 中，不进入日志、DuckDB、SSE、浏览器响应或 session 文件。

`LLM_BASE_URL` 必须为 HTTPS，或开发环境中的 loopback HTTP URL。数值和布尔变量使用严格解析，不接受静默回退。模型配置文件采用原子写入或确定性覆盖，保证同一 session 重启时配置一致。不同 session 仍使用不同 `agentDir`，不会共享 auth、models 或 session 状态。

## Compatibility profiles

首版只提供两个 profile：

- `openai`：标准 OpenAI-compatible Chat Completions 行为。
- `kimi`：在标准行为上启用 `deferredToolsMode: "kimi"`。

profile 是一个受控枚举，不允许通过环境变量注入任意 JSON。`context_length` 映射为 `contextWindow`；视觉能力映射为 `input: ["text", "image"]`；reasoning effort 同时用于模型 capability 和 session `thinkingLevel`。不支持某能力的 endpoint 应通过配置关闭该能力，而不是让请求在运行中失败。

Kimi Coding Plan 的内置默认配置等价于：

```text
LLM_BASE_URL=https://api.kimi.com/coding/v1
LLM_MODEL=k3-256k
LLM_CONTEXT_LENGTH=262144
LLM_REASONING_EFFORT=high
LLM_SUPPORTS_VISION=true
LLM_COMPAT_PROFILE=kimi
```

这些默认值不要求用户重复导出；本地运行只需设置：

```text
KIMI_API_KEY=<secret>
```

当前 Web 客户端仍仅支持文本输入。本次只允许底层模型声明图片能力，不新增上传、存储或视觉消息 UI。

## 测试

测试优先覆盖：

- 缺少 API Key 时创建失败且错误不泄露凭证。
- 未设置可选覆盖变量时使用 Kimi Coding Plan 默认值。
- session 的 `models.json` 包含经过校验的 base URL、model、上下文和视觉能力。
- runtime API Key 注入到内部固定 provider ID。
- 模型选择使用配置的 model ID。
- `createAgentSession()` 使用配置的 reasoning level。
- `kimi` profile 启用 Kimi deferred tools compatibility；`openai` profile 不启用。
- 非 HTTPS 外部 URL、非法 context、非法 boolean、未知 profile 和未知 reasoning level 均被拒绝。
- 两个研究工具、默认编码工具禁用和 session 目录隔离不回归。
- 全量 TypeScript、Python 和真实 HTTP E2E 验证继续通过；E2E 不调用付费 Kimi API。

## 非目标

- 不支持单个 chat 在运行中切换 provider/model；服务重启后可使用新的环境配置。
- 不安装或加载 Kimi pi 扩展。
- 不复用用户全局 `~/.pi` 登录状态。
- 不实现图片上传或视觉聊天 UI。
- 不将 API Key 写入仓库或任何配置文件。
- 不设计通用 provider plugin 或可插拔 Agent 接口。

# API Switch

Use your own relay models in Codex Desktop and Claude Code without giving up the native coding-agent experience.

API Switch is a local Web UI, CLI, and protocol router for connecting coding clients to OpenAI, Claude, Gemini, Grok, DeepSeek, and self-hosted models behind a relay API. It keeps the client-facing protocol stable, stores real API keys locally, and only bridges the model families that actually need bridging.

Supported clients:

- Codex Desktop through its built-in OpenAI API mode and `openai_base_url`.
- Claude Code through `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

The public product name, repository, package, and command are all `api-switch`.

## Install

This project is currently distributed from GitHub.

```bash
npm install -g github:ffffff9331/api-switch
```

Start the Web UI:

```bash
api-switch web
```

Default URL:

```text
http://127.0.0.1:18600
```

From a local clone:

```bash
git clone https://github.com/ffffff9331/api-switch.git
cd api-switch
npm install -g .
api-switch web
```

## Release Highlights

This release focuses on one thing: making relay models feel native inside Codex and Claude Code.

- **Native long-task path by default.** GPT, Gemini, Grok, DeepSeek, and other non-Claude models stay on native `/v1/responses`, so Codex streaming, tools, and long-running work are not rewritten by API Switch.
- **Claude works where native Responses does not.** `claude-*` is automatically bridged through `/v1/chat/completions` and wrapped back into Responses or Anthropic Messages for the client.
- **No surprise token spend from the Web UI.** The page reads local configuration only. Upstream calls happen only when you click `Load Models` or `Test Access`.
- **One switchboard for coding clients.** Save a relay once, then attach it to Codex, Claude Code, or advanced model-name routes from the same local UI.
- **Safer by design.** Real relay keys stay in local key files; Codex and Claude Code only receive the local proxy token.

## How It Works

API Switch runs a local proxy at:

```text
http://127.0.0.1:18600/v1
```

For Codex, `Use for Codex` writes Codex API mode to use the local proxy:

```text
openai_base_url = "http://127.0.0.1:18600/v1"
```

Codex receives a local placeholder API key:

```text
api-switch
```

The real relay API key stays in a local key file and is never written to Codex config.

For Claude Code, `Use for Claude Code` writes:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18600",
    "ANTHROPIC_AUTH_TOKEN": "api-switch"
  }
}
```

## Web UI

The Web UI lets you:

- Save relay profiles with name, base URL, API key, and default model.
- Load model IDs from the relay `/models` endpoint.
- Test a saved relay profile on demand.
- Use a profile for Codex.
- Use a profile for Claude Code.
- Switch Codex back to account mode.
- Configure advanced model-name mappings when a client model name must map to a different upstream model.

Normal flow:

1. Run `api-switch web`.
2. Add a relay profile.
3. Click `Use for Codex` or `Use for Claude Code`.
4. Keep the Web UI or service running while the client uses the local proxy.

Only `Load Models` and `Test Access` make upstream model/API requests from the Web UI.

## Codex

Use a relay profile for Codex:

```bash
api-switch default --name vayne
```

Switch Codex back to account login:

```bash
api-switch account
```

With app restart:

```bash
api-switch default --name vayne --restart-codex
api-switch account --restart-codex
```

API Switch keeps Codex on its built-in `openai` provider path and only points `openai_base_url` to the local proxy. This preserves Codex behavior better than replacing the built-in provider.

When switching, API Switch updates local Codex thread metadata so archived and unarchived conversations remain visible as much as possible. It backs up `~/.codex/state_5.sqlite` before changing the database.

## Claude Code

Use a relay profile for Claude Code:

```bash
api-switch claude-proxy --name vayne
```

Remove Claude Code proxy settings:

```bash
api-switch claude-account
```

The local proxy accepts Anthropic-style requests at:

```text
POST http://127.0.0.1:18600/v1/messages
```

## Local Proxy

Start the proxy together with the Web UI:

```bash
api-switch web
```

Or run only the proxy:

```bash
api-switch proxy
```

Endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/messages`

Routing policy:

- `gpt-*`, `o*`, Gemini, Grok, DeepSeek, and unknown model names use native `/v1/responses` passthrough.
- `claude-*` uses the chat-completions bridge because many relay providers do not expose native Responses for Claude.
- Claude Code `/v1/messages` is bridged through chat completions when needed.

## Model Routes

Advanced model-name mapping lets a client keep one model name while the proxy sends another upstream model.

```bash
api-switch route \
  --client codex \
  --model gpt-5.5 \
  --profile claude \
  --upstream-model claude-opus-4-6
```

List routes:

```bash
api-switch routes
```

Remove a route:

```bash
api-switch route-remove --client codex --model gpt-5.5
```

## Background Service

On macOS, install and start the LaunchAgent:

```bash
api-switch service-install
```

Other service helpers:

```bash
api-switch service-status
api-switch service-uninstall
```

## Files

Internal storage paths use the API Switch directory:

```text
~/.codex/api-switch/profiles.json
~/.codex/api-switch/routes.json
~/.codex/api-switch/proxy-settings.json
~/.codex/api-switch/proxy-logs/
```

Enable debug logs:

```bash
API_SWITCH_DEBUG_PROXY=1 api-switch proxy
```

## Roadmap

API Switch already focuses on protocol correctness for Codex and Claude Code. The next product gaps are:

- **Closer Claude parity.** Claude is bridged through chat completions today; the goal is to cover more complex Responses edge cases without pretending the bridge is native.
- **Profile capability detection.** Detect whether each relay supports `/v1/responses`, `/v1/chat/completions`, `/v1/messages`, streaming, tools, and vision before choosing a route.
- **More guided Web UI.** Add first-run guidance, clearer connection state, service status, and actionable recovery steps for common setup errors.
- **Passive request visibility.** Show real proxy requests that already happened without running background model diagnostics or spending extra tokens.
- **Smarter model routing.** Make client-specific model mapping, model-family defaults, bridge selection, and fallback behavior easier to see and configure.
- **Smoother distribution.** Move beyond GitHub install toward npm/Homebrew-style install and update flows.

## Compatibility Notes

- Repository, package name, product name, and command are all `api-switch`.
- Internal storage lives under `~/.codex/api-switch/`.

---

# API Switch 中文说明

让 Codex Desktop 和 Claude Code 用上你的中转站模型，同时尽量保留原生编程 Agent 的长任务、工具调用和流式体验。

API Switch 是一个本地 Web UI、命令行工具和协议路由层，用来把 Codex Desktop、Claude Code 接到中转站里的 OpenAI、Claude、Gemini、Grok、DeepSeek 和自建模型。它稳定客户端协议，本地保存真实 API Key，只对确实需要转换的模型族做桥接。

当前支持：

- Codex Desktop：通过 Codex 内置 OpenAI API 模式和 `openai_base_url` 接入。
- Claude Code：通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 接入。

公开产品名、仓库名、包名和主命令统一为 `api-switch`。

## 安装

目前从 GitHub 安装：

```bash
npm install -g github:ffffff9331/api-switch
```

启动 Web UI：

```bash
api-switch web
```

默认地址：

```text
http://127.0.0.1:18600
```

## 这版更新

这一版只解决一个核心问题：让中转站模型在 Codex 和 Claude Code 里尽量像原生模型一样工作。

- **默认保留原生长任务链路。** GPT、Gemini、Grok、DeepSeek 和其他非 Claude 模型都原生走 `/v1/responses`，Codex 的流式输出、工具调用、长任务不会被 API Switch 重写。
- **Claude 自动桥接。** `claude-*` 会自动走 `/v1/chat/completions`，再包装回 Codex 需要的 Responses 或 Claude Code 需要的 Messages。
- **Web UI 不偷跑消耗。** 页面只读本地配置；只有点击“读取模型”或“检测接入”才会请求上游。
- **一个本地开关管理多个客户端。** 同一个中转配置，可以在 Web UI 里切给 Codex、Claude Code，也可以做高级模型名映射。
- **真实密钥不进客户端配置。** Codex 和 Claude Code 只拿到本地代理 token，真实中转 API Key 留在本地 key file。

## 基本使用

1. 运行 `api-switch web`。
2. 在 Web UI 新增中转配置，填写名称、Base URL、API Key 和默认模型。
3. 点击 `用于 Codex` 或 `用于 Claude Code`。
4. 使用客户端时保持 Web UI 或后台服务运行。

## Codex

给 Codex 使用某个中转配置：

```bash
api-switch default --name vayne
```

切回 Codex 账号登录：

```bash
api-switch account
```

API Switch 不覆盖 Codex 内置的 `openai` provider，只把 Codex 的 `openai_base_url` 指到本地代理，这样能尽量保留 Codex 原本的长任务、工具调用、历史会话和 Git 撤销能力。

## Claude Code

给 Claude Code 使用某个中转配置：

```bash
api-switch claude-proxy --name vayne
```

移除 Claude Code 代理配置：

```bash
api-switch claude-account
```

## 本地代理

本地代理地址：

```text
http://127.0.0.1:18600/v1
```

支持：

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/messages`

路由策略：

- `gpt-*`、`o*`、Gemini、Grok、DeepSeek 和未知模型名默认原生透传 `/v1/responses`。
- `claude-*` 使用 chat-completions 桥接，因为很多中转站没有给 Claude 暴露原生 Responses。
- Claude Code 的 `/v1/messages` 会在需要时桥接到 chat completions。

## 高级：模型名映射

只有在“客户端必须显示一个模型名，但上游实际要发另一个模型名”时才需要。

```bash
api-switch route \
  --client codex \
  --model gpt-5.5 \
  --profile claude \
  --upstream-model claude-opus-4-6
```

查看：

```bash
api-switch routes
```

删除：

```bash
api-switch route-remove --client codex --model gpt-5.5
```

## 后台服务

macOS 安装并启动后台服务：

```bash
api-switch service-install
```

查看或卸载：

```bash
api-switch service-status
api-switch service-uninstall
```

## 后续路线

API Switch 当前优先解决 Codex 和 Claude Code 的协议正确性。下一步要补的产品能力是：

- **更接近原生的 Claude 体验。** 目前 Claude 通过 chat completions 桥接，后续要覆盖更多复杂 Responses 场景，但不会把桥接伪装成原生。
- **中转配置能力探测。** 自动识别每个中转是否支持 `/v1/responses`、`/v1/chat/completions`、`/v1/messages`、流式、工具和视觉输入。
- **更清晰的 Web 引导。** 增加首次使用引导、连接状态、常驻服务状态，以及常见错误的恢复建议。
- **不额外耗 token 的请求可视化。** 只展示真实发生过的代理请求，不在后台主动跑模型诊断。
- **更智能的模型路由。** 让按客户端映射、按模型族默认策略、桥接选择和 fallback 行为更容易查看和配置。
- **更顺滑的安装更新。** 后续从 GitHub 安装继续推进到 npm/Homebrew 风格的安装和更新流程。

## 兼容说明

- 仓库名、包名、产品名和命令统一为 `api-switch`。
- 内部配置目录为 `~/.codex/api-switch/`。
- 推荐使用 `API_SWITCH_DEBUG_PROXY=1` 开启调试日志。

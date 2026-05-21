# API Switch

API Switch is a local Web UI, CLI, and proxy gateway for using relay APIs with AI coding clients.

Supported clients:

- Codex Desktop through its built-in OpenAI API mode and `openai_base_url`.
- Claude Code through `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

The public product name and command are `api-switch`. The old `codex-switch` command remains as a compatibility alias for existing installs.

## Install

This project is currently distributed from GitHub.

```bash
npm install -g github:ffffff9331/codex-switch
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
git clone https://github.com/ffffff9331/codex-switch.git
cd codex-switch
npm install -g .
api-switch web
```

## Release Highlights

- Default routing preserves native `/v1/responses` for GPT, Gemini, Grok, DeepSeek, and other non-Claude models.
- Only `claude-*` models use the bridge path: `/v1/responses` or `/v1/messages` to `/v1/chat/completions`, then back to the client protocol.
- Streaming Responses are passed through unchanged for non-Claude models, so Codex long tasks and tool events are not rewritten by the proxy.
- Claude streaming bridge now handles common SSE frame formats and keeps text/tool-call events flowing back to Codex and Claude Code.
- The Web UI is configuration-first: saved profiles, model loading, access testing, client switching, and advanced model-name mapping. It does not run background model diagnostics on page load.

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

Internal storage paths keep the legacy directory name for compatibility with existing users:

```text
~/.codex/codex-switch/profiles.json
~/.codex/codex-switch/routes.json
~/.codex/codex-switch/proxy-settings.json
~/.codex/codex-switch/proxy-logs/
```

Enable debug logs:

```bash
API_SWITCH_DEBUG_PROXY=1 api-switch proxy
```

`CODEX_SWITCH_DEBUG_PROXY=1` is still accepted as a compatibility alias.

## Compatibility Notes

- The install repository is still named `codex-switch`, but the product and command are `api-switch`.
- `codex-switch` remains as a CLI alias to avoid breaking existing installs.
- Internal storage under `~/.codex/codex-switch/` is preserved to keep existing user profiles and migrations working.

---

# API Switch 中文说明

API Switch 是一个本地 Web UI、命令行工具和代理网关，用来让 Codex Desktop、Claude Code 等编程客户端使用你的中转 API。

当前支持：

- Codex Desktop：通过 Codex 内置 OpenAI API 模式和 `openai_base_url` 接入。
- Claude Code：通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 接入。

公开产品名和主命令统一为 `api-switch`。旧的 `codex-switch` 命令只作为兼容别名保留。

## 安装

目前从 GitHub 安装：

```bash
npm install -g github:ffffff9331/codex-switch
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

- 默认所有非 Claude 模型都走原生 `/v1/responses`，包括 GPT、Gemini、Grok、DeepSeek 和其他自建模型。
- 只有 `claude-*` 走桥接：`/v1/responses` 或 `/v1/messages` 转 `/v1/chat/completions`，再包装回客户端需要的协议。
- 非 Claude 的流式 Responses 原样透传，避免 Codex 长任务、工具事件被代理层改短或改坏。
- Claude 流式桥接增强了 SSE 解析，兼容常见换行格式，并保留文本和工具调用事件。
- Web UI 不再自动跑模型诊断；只有点击“读取模型”或“检测接入”才会请求上游。

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

## 兼容说明

- 仓库名暂时仍是 `codex-switch`，产品名和主命令是 `api-switch`。
- `codex-switch` 命令作为旧版兼容别名继续可用。
- `~/.codex/codex-switch/` 目录暂时保留，避免破坏已有用户配置。
- 推荐使用 `API_SWITCH_DEBUG_PROXY=1` 开启调试日志；旧的 `CODEX_SWITCH_DEBUG_PROXY=1` 仍然兼容。

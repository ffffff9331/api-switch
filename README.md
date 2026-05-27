# API Switch

让 Codex Desktop 和 Claude Code 用上你的中转站模型，同时保留原生编程 Agent 的长任务、工具调用和流式体验。

API Switch 是一个本地 Web UI、命令行工具和协议路由器，用来把 Codex Desktop 和 Claude Code 接到中转站里的 OpenAI、Claude、Gemini、Grok、DeepSeek 和自建模型。它稳定客户端协议，本地保存真实 API Key，只对需要转换的模型族做桥接。

支持的客户端：

- **Codex Desktop**：通过内置 OpenAI API 模式和 `openai_base_url` 接入。
- **Claude Code**：通过 `ANTHROPIC_BASE_URL` 和 `ANTHROPIC_AUTH_TOKEN` 接入。

产品名、仓库名、包名和主命令统一为 `api-switch`。

## 安装

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

从本地克隆安装：

```bash
git clone https://github.com/ffffff9331/api-switch.git
cd api-switch
npm install -g .
api-switch web
```

## 这版更新

核心目标：让中转站模型在 Codex 和 Claude Code 里尽量像原生模型一样工作。

- **严格按选择的接口转发。** 用户在 Web UI 选择 `/v1/chat/completions`、`/v1/responses` 或 `/anthropic/v1/messages` 后，proxy 严格按该接口转发，不做协议 fallback。
- **模型名不泄漏。** 发给上游的模型名始终使用 profile 配置的 model，不会把客户端传来的旧模型名泄漏给上游。
- **Claude 自动桥接。** `claude-*` 通过 `/v1/chat/completions` 桥接，自动转换为 Codex 需要的 Responses 格式或 Claude Code 需要的 Anthropic Messages 格式，支持工具调用和流式输出。
- **不兼容输入自动降级。** 当上游不支持图片输入时，自动将 image part 降级为文本占位，避免上游报错。
- **Web UI 不偷跑消耗。** 页面只读本地配置；只有点击"读取模型"或"检测接入"才会请求上游。
- **真实密钥不进客户端配置。** Codex 和 Claude Code 只拿到本地代理 token，真实中转 API Key 留在本地 key file。

## 基本使用

1. 运行 `api-switch web`。
2. 在 Web UI 新增中转配置，填写名称、Base URL、API Key、默认模型，选择支持的接口。
3. 点击"用于 Codex"或"用于 Claude Code"。
4. 使用客户端时保持 Web UI 或后台服务运行。

Web UI 功能：

- 新增、编辑、复制、删除中转配置
- 读取上游模型列表
- 检测接入是否正常
- 一键切换给 Codex 或 Claude Code 使用
- 导入/导出配置（JSON）
- 查看最近代理请求日志
- 深色模式自动适配系统

## Codex

给 Codex 使用某个中转配置：

```bash
api-switch default --name vayne
```

切回 Codex 账号登录：

```bash
api-switch account
```

带应用重启：

```bash
api-switch default --name vayne --restart-codex
api-switch account --restart-codex
```

API Switch 不覆盖 Codex 内置的 `openai` provider，只把 `openai_base_url` 指到本地代理，保留 Codex 原本的长任务、工具调用、历史会话和 Git 撤销能力。

切换时会自动迁移 Codex 线程元数据，并在修改数据库前备份 `~/.codex/state_5.sqlite`。

## Claude Code

给 Claude Code 使用某个中转配置：

```bash
api-switch claude-proxy --name vayne
```

移除 Claude Code 代理配置：

```bash
api-switch claude-account
```

本地代理接受 Anthropic 格式请求：

```text
POST http://127.0.0.1:18600/v1/messages
```

## 本地代理

启动代理 + Web UI：

```bash
api-switch web
```

仅启动代理：

```bash
api-switch proxy
```

接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/messages`

## 模型路由

高级模型名映射：让客户端保留一个模型名，但 proxy 实际发给上游另一个模型。

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

## 调试

开启调试日志：

```bash
API_SWITCH_DEBUG_PROXY=1 api-switch web
```

调试日志保存在 `~/.codex/api-switch/proxy-logs/`，包含路由决策、上游请求/响应、payload 摘要等信息。

## 兼容说明

- 仓库名、包名、产品名和命令统一为 `api-switch`。
- 内部配置目录为 `~/.codex/api-switch/`。

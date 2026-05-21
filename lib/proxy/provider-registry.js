"use strict";

const openaiAdapter = require("./upstream-openai");
const claudeAdapter = require("./upstream-claude");

const PROVIDERS = {
  openai: {
    family: "openai",
    upstreamProtocol: "responses",
    streamStrategy: "passthrough",
    adapter: openaiAdapter,
    capabilities: {
      responses: true,
      messages: false,
      streaming: true,
      tools: true,
      vision: true,
      localBridge: "passthrough",
    },
    matches(model) {
      return (
        model.startsWith("gpt-") ||
        model.startsWith("o1") ||
        model.startsWith("o3") ||
        model.startsWith("o4")
      );
    },
  },
  claude: {
    family: "claude",
    upstreamProtocol: "chat-completions",
    streamStrategy: "chat-completions-bridge",
    adapter: claudeAdapter,
    capabilities: {
      responses: true,
      messages: true,
      streaming: true,
      tools: true,
      vision: true,
      localBridge: "chat-completions-bridge",
    },
    matches(model) {
      return model.startsWith("claude-");
    },
  },
  generic: {
    family: "generic",
    upstreamProtocol: "responses",
    streamStrategy: "passthrough",
    adapter: openaiAdapter,
    capabilities: {
      responses: true,
      messages: false,
      streaming: true,
      tools: true,
      vision: false,
      localBridge: "passthrough",
    },
    matches() {
      return true;
    },
  },
};

function providerForModel(model) {
  const normalized = String(model || "").trim().toLowerCase();
  if (!normalized) {
    return {
      ...PROVIDERS.generic,
      family: "unknown",
    };
  }
  return Object.values(PROVIDERS).find((provider) => provider.matches(normalized)) || PROVIDERS.generic;
}

function routeModel(model) {
  const provider = providerForModel(model);
  return {
    family: provider.family,
    upstreamProtocol: provider.upstreamProtocol,
    streamStrategy: provider.streamStrategy,
  };
}

function adapterForModel(model) {
  return providerForModel(model).adapter;
}

function capabilitiesForModel(model) {
  const provider = providerForModel(model);
  const name = String(model || "");
  return {
    model: name,
    family: provider.family,
    ...provider.capabilities,
    vision: provider.capabilities.vision || /vision|opus|sonnet|gpt-4|gpt-5/i.test(name),
  };
}

module.exports = {
  adapterForModel,
  capabilitiesForModel,
  providerForModel,
  routeModel,
};

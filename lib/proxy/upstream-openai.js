"use strict";

const { passthroughModels, passthroughResponses, passthroughResponsesCompact } = require("./upstream-base");
const { proxyMessagesViaChat, proxyResponsesViaAnthropic, proxyResponsesViaChat, proxyResponsesViaCompletions } = require("./chat-bridge");
const { writeDebugLog } = require("./debug-log");

async function proxyModels(args) {
  return passthroughModels(args);
}

async function proxyResponses(args) {
  const protocol = args.profile && (args.profile.codexUpstreamProtocol || args.profile.upstreamProtocol);
  writeDebugLog(args.debugDir, "route-decision", {
    traceId: args.traceId,
    profile: args.profile && args.profile.name,
    model: args.profile && args.profile.model,
    profileProtocol: protocol || "",
    route: args.route,
    selected: protocol === "chat-completions" ? "chat-completions-bridge" : protocol === "completions" ? "completions-bridge" : protocol === "anthropic-messages" ? "anthropic-messages-bridge" : "responses-passthrough",
  });
  if (protocol === "chat-completions") {
    return proxyResponsesViaChat(args);
  }
  if (protocol === "completions") {
    return proxyResponsesViaCompletions(args);
  }
  if (protocol === "anthropic-messages") {
    return proxyResponsesViaAnthropic(args);
  }
  return passthroughResponses(args);
}

async function proxyResponsesCompact(args) {
  return passthroughResponsesCompact(args);
}

async function proxyMessages(args) {
  return proxyMessagesViaChat(args);
}

module.exports = {
  proxyMessages,
  proxyModels,
  proxyResponses,
  proxyResponsesCompact,
};

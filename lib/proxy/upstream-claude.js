"use strict";

const { passthroughModels, passthroughResponses } = require("./upstream-base");
const { proxyMessagesViaChat, proxyResponsesViaChat } = require("./chat-bridge");

async function proxyModels(args) {
  return passthroughModels(args);
}

async function proxyResponses(args) {
  const protocol = args.profile && (args.profile.codexUpstreamProtocol || args.profile.upstreamProtocol);
  if (protocol === "responses") return passthroughResponses(args);
  return proxyResponsesViaChat(args);
}

async function proxyMessages(args) {
  return proxyMessagesViaChat(args);
}

module.exports = {
  proxyMessages,
  proxyModels,
  proxyResponses,
};

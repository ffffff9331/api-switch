"use strict";

const { passthroughModels, passthroughResponses, passthroughResponsesCompact } = require("./upstream-base");
const { proxyMessagesViaChat } = require("./chat-bridge");

async function proxyModels(args) {
  return passthroughModels(args);
}

async function proxyResponses(args) {
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

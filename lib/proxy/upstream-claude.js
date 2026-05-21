"use strict";

const { passthroughModels } = require("./upstream-base");
const { proxyMessagesViaChat, proxyResponsesViaChat } = require("./chat-bridge");

async function proxyModels(args) {
  return passthroughModels(args);
}

async function proxyResponses(args) {
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

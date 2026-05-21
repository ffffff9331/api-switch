"use strict";

const { passthroughModels, passthroughResponses } = require("./upstream-base");
const { proxyMessagesViaChat } = require("./chat-bridge");

async function proxyModels(args) {
  return passthroughModels(args);
}

async function proxyResponses(args) {
  return passthroughResponses(args);
}

async function proxyMessages(args) {
  return proxyMessagesViaChat(args);
}

module.exports = {
  proxyMessages,
  proxyModels,
  proxyResponses,
};

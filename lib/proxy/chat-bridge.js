"use strict";

const { chatCompletionsUrl, completionsUrl, fetchChatCompletions, fetchCompletions, passthroughMessages, passthroughResponses } = require("./upstream-base");
const { writeDebugLog } = require("./debug-log");
const { primeStreamingResponse } = require("./stability");

function now() {
  return Math.floor(Date.now() / 1000);
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
}

function parseJsonBody(body) {
  if (!body || !body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}

function textFromContentPart(part) {
  if (!part) return "";
  if (typeof part === "string") return part;
  if (typeof part.text === "string") return part.text;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  if (part.type === "text" && typeof part.content === "string") return part.content;
  return "";
}

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.url === "string") return part.url;
  if (typeof part.image_url === "string") return part.image_url;
  if (part.image_url && typeof part.image_url.url === "string") return part.image_url.url;
  if (typeof part.file_id === "string") return part.file_id;
  return "";
}

function chatContentFromResponsesContent(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContentPart(content);

  const parts = [];
  for (const part of content) {
    if (!part) continue;
    const text = textFromContentPart(part);
    if (text) {
      parts.push({ type: "text", text });
      continue;
    }
    const imageUrl = imageUrlFromPart(part);
    if (part.type === "input_image" && imageUrl) {
      if (options.textOnlyImages) {
        parts.push({ type: "text", text: "[Image input omitted: this upstream only supports text/tool chat completions.]" });
      } else {
        parts.push({ type: "image_url", image_url: { url: imageUrl } });
      }
    }
  }
  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function textFromResponsesInput(input) {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.content === "string") return item.content;
      if (Array.isArray(item.content)) return item.content.map(textFromContentPart).filter(Boolean).join("\n");
      return item.text || item.input_text || "";
    }).filter(Boolean).join("\n");
  }
  if (typeof input === "object") return input.text || input.input_text || JSON.stringify(input);
  return String(input);
}

function responsesInputToMessages(body, options = {}) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  if (Array.isArray(body.messages)) return messages.concat(body.messages);

  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        messages.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id || "call",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
        });
        continue;
      }
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [{
            id: item.call_id || item.id || "call",
            type: "function",
            function: {
              name: item.name || "tool",
              arguments: item.arguments || "{}",
            },
          }],
        });
        continue;
      }
      const role = item.role === "assistant" || item.role === "system" || item.role === "tool" ? item.role : "user";
      const content = chatContentFromResponsesContent(item.content || item.text || item.input_text || "", options);
      if (content) messages.push({ role, content });
    }
  } else {
    const text = textFromResponsesInput(input);
    messages.push({ role: "user", content: text || "hi" });
  }
  return messages.length ? messages : [{ role: "user", content: "hi" }];
}

function responsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function) {
      mapped.push(tool);
    } else if (tool.type === "function" || tool.name) {
      mapped.push({
        type: "function",
        function: {
          name: tool.name || (tool.function && tool.function.name),
          description: tool.description || (tool.function && tool.function.description) || "",
          parameters: tool.parameters || (tool.function && tool.function.parameters) || { type: "object", properties: {} },
        },
      });
    } else if (tool.type) {
      mapped.push({
        type: "function",
        function: {
          name: String(tool.type).replace(/[^a-zA-Z0-9_-]/g, "_"),
          description: tool.description || `Codex tool: ${tool.type}`,
          parameters: tool.parameters || { type: "object", additionalProperties: true },
        },
      });
    }
  }
  return mapped.length ? mapped : undefined;
}

function responsesToChatPayload(body, model, options = {}) {
  const payload = {
    model,
    messages: responsesInputToMessages(body, options),
    stream: Boolean(body.stream),
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.presence_penalty !== undefined) payload.presence_penalty = body.presence_penalty;
  if (body.frequency_penalty !== undefined) payload.frequency_penalty = body.frequency_penalty;
  if (body.user !== undefined) payload.user = body.user;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.parallel_tool_calls !== undefined) payload.parallel_tool_calls = body.parallel_tool_calls;
  if (body.stream_options !== undefined) payload.stream_options = body.stream_options;
  if (body.response_format !== undefined) payload.response_format = body.response_format;
  if (body.max_output_tokens || body.max_tokens) payload.max_tokens = body.max_output_tokens || body.max_tokens;
  const tools = responsesToolsToChatTools(body.tools);
  if (tools) payload.tools = tools;
  if (body.tool_choice) payload.tool_choice = body.tool_choice;
  return payload;
}

function anthropicContentToChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return textFromContentPart(content);
  const parts = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image" && part.source) {
      if (part.source.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: `data:${part.source.media_type || "image/png"};base64,${part.source.data || ""}` } });
      } else if (part.source.url) {
        parts.push({ type: "image_url", image_url: { url: part.source.url } });
      }
    }
  }
  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function anthropicToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const mapped = tools.filter((tool) => tool && tool.name).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
  return mapped.length ? mapped : undefined;
}

function anthropicMessagesToChatMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: typeof body.system === "string" ? body.system : JSON.stringify(body.system) });
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (!Array.isArray(message.content)) {
      messages.push({ role, content: anthropicContentToChatContent(message.content) });
      continue;
    }

    const textAndImages = [];
    const toolCalls = [];
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: part.tool_use_id || part.id || "call",
          content: typeof part.content === "string" ? part.content : JSON.stringify(part.content || ""),
        });
        continue;
      }
      if (part.type === "tool_use") {
        toolCalls.push({
          id: part.id || "call",
          type: "function",
          function: {
            name: part.name || "tool",
            arguments: JSON.stringify(part.input || {}),
          },
        });
        continue;
      }
      const converted = anthropicContentToChatContent([part]);
      if (Array.isArray(converted)) textAndImages.push(...converted);
      else if (converted) textAndImages.push({ type: "text", text: converted });
    }
    if (toolCalls.length) {
      const text = textAndImages.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      messages.push({ role: "assistant", content: text || "", tool_calls: toolCalls });
    } else if (textAndImages.length) {
      messages.push({
        role,
        content: textAndImages.every((part) => part.type === "text") ? textAndImages.map((part) => part.text).join("\n") : textAndImages,
      });
    }
  }
  return messages;
}

function anthropicToolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined;
  if (toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "none") return "none";
  if ((toolChoice.type === "tool" || toolChoice.type === "any") && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return undefined;
}

function anthropicToChatPayload(body, model) {
  const messages = anthropicMessagesToChatMessages(body);
  const payload = {
    model,
    messages: messages.length ? messages : [{ role: "user", content: "hi" }],
    stream: Boolean(body.stream),
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.max_tokens) payload.max_tokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences)) payload.stop = body.stop_sequences;
  const tools = anthropicToolsToChatTools(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = anthropicToolChoiceToChat(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;
  return payload;
}

function chatText(chat) {
  const content = chat && chat.choices && chat.choices[0] && chat.choices[0].message && chat.choices[0].message.content;
  if (Array.isArray(content)) return content.map(textFromContentPart).join("");
  return typeof content === "string" ? content : "";
}

function chatToolCalls(chat) {
  return (chat && chat.choices && chat.choices[0] && chat.choices[0].message && chat.choices[0].message.tool_calls) || [];
}

function chatToResponses(chat, model) {
  const responseId = id("resp");
  const output = [];
  const text = chatText(chat);
  if (text) {
    output.push({
      id: id("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of chatToolCalls(chat)) {
    if (!call || !call.function) continue;
    output.push({
      id: call.id || id("fc"),
      type: "function_call",
      call_id: call.id || id("call"),
      name: call.function.name,
      arguments: call.function.arguments || "{}",
      status: "completed",
    });
  }
  return {
    id: responseId,
    object: "response",
    created_at: chat.created || now(),
    model: chat.model || model,
    status: "completed",
    output,
    usage: chat.usage || null,
  };
}

function chatToAnthropic(chat, model) {
  const text = chatText(chat);
  const toolCalls = chatToolCalls(chat);
  const content = [];
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    if (!call || !call.function) continue;
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = { arguments: call.function.arguments || "" };
    }
    content.push({
      type: "tool_use",
      id: call.id || id("toolu"),
      name: call.function.name || "tool",
      input,
    });
  }
  return {
    id: id("msg"),
    type: "message",
    role: "assistant",
    model: chat.model || model,
    content,
    stop_reason: toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: (chat.usage && (chat.usage.prompt_tokens || chat.usage.input_tokens)) || 0,
      output_tokens: (chat.usage && (chat.usage.completion_tokens || chat.usage.output_tokens)) || 0,
    },
  };
}

function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function splitSseFrames(buffer) {
  const normalized = String(buffer || "").replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  return {
    frames: parts.slice(0, -1),
    buffer: parts[parts.length - 1] || "",
  };
}

function writeResponsesFailureSse(res, responseId, model, error) {
  const payload = {
    id: responseId,
    object: "response",
    created_at: now(),
    status: "failed",
    model,
    output: [],
    error: {
      message: String((error && (error.message || error.error || error.type)) || "Upstream stream failed."),
      type: (error && (error.type || error.code)) || "upstream_error",
      code: error && error.code ? error.code : null,
    },
  };
  sse(res, "response.failed", { type: "response.failed", response: payload });
  res.write("data: [DONE]\n\n");
  res.end();
}

function allocateTextOutputIndex(state) {
  if (state.textOutputIndex === undefined) state.textOutputIndex = state.nextOutputIndex++;
  return state.textOutputIndex;
}

function writeResponsesTextSse(res, ids, deltaState, delta) {
  if (!delta) return;
  const outputIndex = allocateTextOutputIndex(deltaState);
  if (!deltaState.itemAdded) {
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: ids.messageId, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    sse(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: ids.messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    deltaState.itemAdded = true;
  }
  deltaState.fullText += delta;
  sse(res, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: ids.messageId,
    output_index: outputIndex,
    content_index: 0,
    delta,
  });
}

function ensureToolCallState(state, deltaToolCall) {
  const index = deltaToolCall.index || 0;
  if (!state.toolCalls.has(index)) {
    state.toolCalls.set(index, {
      id: deltaToolCall.id || id("call"),
      itemId: deltaToolCall.id || id("fc"),
      name: (deltaToolCall.function && deltaToolCall.function.name) || "",
      arguments: "",
      added: false,
      outputIndex: state.nextOutputIndex++,
    });
  }
  const call = state.toolCalls.get(index);
  if (deltaToolCall.id && (!call.id || call.id.startsWith("call_"))) call.id = deltaToolCall.id;
  if (deltaToolCall.id && (!call.itemId || call.itemId.startsWith("fc_"))) call.itemId = deltaToolCall.id;
  if (deltaToolCall.function && deltaToolCall.function.name) call.name = deltaToolCall.function.name;
  return call;
}

function writeResponsesToolCallSse(res, state, deltaToolCall) {
  if (!deltaToolCall) return;
  const call = ensureToolCallState(state, deltaToolCall);
  if (!call.added && call.name) {
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: call.outputIndex,
      item: {
        id: call.itemId,
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: "",
        status: "in_progress",
      },
    });
    call.added = true;
  }
  const delta = deltaToolCall.function && deltaToolCall.function.arguments;
  if (delta) {
    call.arguments += delta;
    sse(res, "response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: call.itemId,
      output_index: call.outputIndex,
      delta,
    });
  }
}

function finishResponsesSse(res, responseId, messageId, model, state) {
  const output = [];
  if (state.itemAdded) {
    const outputIndex = state.textOutputIndex === undefined ? 0 : state.textOutputIndex;
    sse(res, "response.output_text.done", { type: "response.output_text.done", item_id: messageId, output_index: outputIndex, content_index: 0, text: state.fullText });
    sse(res, "response.content_part.done", { type: "response.content_part.done", item_id: messageId, output_index: outputIndex, content_index: 0, part: { type: "output_text", text: state.fullText } });
    const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: state.fullText, annotations: [] }] };
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
    output.push(item);
  }

  for (const call of state.toolCalls.values()) {
    if (!call.added) {
      sse(res, "response.output_item.added", {
        type: "response.output_item.added",
        output_index: call.outputIndex,
        item: { id: call.itemId, type: "function_call", call_id: call.id, name: call.name || "tool", arguments: "", status: "in_progress" },
      });
    }
    sse(res, "response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: call.itemId,
      output_index: call.outputIndex,
      arguments: call.arguments || "{}",
    });
    const item = {
      id: call.itemId,
      type: "function_call",
      call_id: call.id,
      name: call.name || "tool",
      arguments: call.arguments || "{}",
      status: "completed",
    };
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: call.outputIndex, item });
    output.push(item);
  }

  if (!output.length) {
    const outputIndex = allocateTextOutputIndex(state);
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { id: messageId, type: "message", role: "assistant", status: "in_progress", content: [] },
    });
    sse(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    const item = { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "", annotations: [] }] };
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
    output.push(item);
  }

  sse(res, "response.completed", { type: "response.completed", response: { id: responseId, object: "response", created_at: now(), status: "completed", model, output } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeResponsesPayloadAsSse(res, payload) {
  const response = payload || {};
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-api-switch-upstream-protocol": "chat-completions-bridge",
  });
  sse(res, "response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } });
  const output = Array.isArray(response.output) ? response.output : [];
  output.forEach((item, outputIndex) => {
    sse(res, "response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      content.forEach((part, contentIndex) => {
        sse(res, "response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...part, text: "" } });
        const text = textFromContentPart(part);
        if (text) sse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: text });
        sse(res, "response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: outputIndex, content_index: contentIndex, text });
        sse(res, "response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: outputIndex, content_index: contentIndex, part });
      });
    } else if (item.type === "function_call") {
      if (item.arguments) sse(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: outputIndex, delta: item.arguments });
      sse(res, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: outputIndex, arguments: item.arguments || "{}" });
    }
    sse(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
  });
  sse(res, "response.completed", { type: "response.completed", response });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function pipeChatSseAsResponses({ response, res, model }) {
  const responseId = id("resp");
  const messageId = id("msg");
  const state = { itemAdded: false, fullText: "", toolCalls: new Map(), nextOutputIndex: 0 };

  res.writeHead(response.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-api-switch-upstream-protocol": "chat-completions-bridge",
  });
  sse(res, "response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", created_at: now(), status: "in_progress", model, output: [] },
  });

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body || []) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = splitSseFrames(buffer);
    buffer = split.buffer;
    for (const part of split.frames) {
      const lines = part.split("\n").filter((line) => line.startsWith("data:"));
      for (const line of lines) {
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          return writeResponsesFailureSse(res, responseId, model, json.error);
        }
        if (!json.choices || !json.choices[0]) continue;
        const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
        const content = delta && delta.content;
        writeResponsesTextSse(res, { responseId, messageId }, state, Array.isArray(content) ? content.map(textFromContentPart).join("") : content);
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) writeResponsesToolCallSse(res, state, toolCall);
        }
      }
    }
  }
  buffer += decoder.decode();
  const finalSplit = splitSseFrames(`${buffer}\n\n`);
  for (const part of finalSplit.frames) {
    const lines = part.split("\n").filter((line) => line.startsWith("data:"));
    for (const line of lines) {
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        return writeResponsesFailureSse(res, responseId, model, json.error);
      }
      if (!json.choices || !json.choices[0]) continue;
      const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
      const content = delta && delta.content;
      writeResponsesTextSse(res, { responseId, messageId }, state, Array.isArray(content) ? content.map(textFromContentPart).join("") : content);
      if (delta && Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls) writeResponsesToolCallSse(res, state, toolCall);
      }
    }
  }

  finishResponsesSse(res, responseId, messageId, model, state);
}

async function pipeChatSseAsAnthropic({ response, res }) {
  res.writeHead(response.status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-api-switch-upstream-protocol": "chat-completions-bridge",
  });
  const decoder = new TextDecoder();
  let buffer = "";
  let textStarted = false;
  let textDeltas = 0;
  let textBlockIndex = null;
  const toolCalls = new Map();
  let nextIndex = 0;
  for await (const chunk of response.body || []) {
    buffer += decoder.decode(chunk, { stream: true });
    const split = splitSseFrames(buffer);
    buffer = split.buffer;
    for (const part of split.frames) {
      const lines = part.split("\n").filter((line) => line.startsWith("data:"));
      for (const line of lines) {
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) {
          sse(res, "error", { type: "error", error: json.error });
          res.end();
          return;
        }
        const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        const content = delta && delta.content;
        const text = Array.isArray(content) ? content.map(textFromContentPart).join("") : content;
        if (!textStarted && (text || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
          sse(res, "message_start", { type: "message_start", message: { id: id("msg"), type: "message", role: "assistant", content: [], model: json.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
          textStarted = true;
        }
        if (text) {
          if (textDeltas === 0) {
            textBlockIndex = nextIndex++;
            sse(res, "content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
          }
          sse(res, "content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text } });
          textDeltas += 1;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const deltaToolCall of delta.tool_calls) {
            const key = deltaToolCall.index || 0;
            if (!toolCalls.has(key)) {
              const blockIndex = nextIndex++;
              toolCalls.set(key, {
                blockIndex,
                id: deltaToolCall.id || id("toolu"),
                name: deltaToolCall.function && deltaToolCall.function.name || "tool",
                input: "",
                started: false,
              });
            }
            const call = toolCalls.get(key);
            if (deltaToolCall.id) call.id = deltaToolCall.id;
            if (deltaToolCall.function && deltaToolCall.function.name) call.name = deltaToolCall.function.name;
            if (!call.started) {
              sse(res, "content_block_start", { type: "content_block_start", index: call.blockIndex, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
              call.started = true;
            }
            const argDelta = deltaToolCall.function && deltaToolCall.function.arguments;
            if (argDelta) {
              call.input += argDelta;
              sse(res, "content_block_delta", { type: "content_block_delta", index: call.blockIndex, delta: { type: "input_json_delta", partial_json: argDelta } });
            }
          }
        }
      }
    }
  }
  buffer += decoder.decode();
  const finalSplit = splitSseFrames(`${buffer}\n\n`);
  for (const part of finalSplit.frames) {
    const lines = part.split("\n").filter((line) => line.startsWith("data:"));
    for (const line of lines) {
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) {
        sse(res, "error", { type: "error", error: json.error });
        res.end();
        return;
      }
      const delta = json && json.choices && json.choices[0] && json.choices[0].delta;
      if (!delta) continue;
      const content = delta && delta.content;
      const text = Array.isArray(content) ? content.map(textFromContentPart).join("") : content;
      if (!textStarted && (text || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
        sse(res, "message_start", { type: "message_start", message: { id: id("msg"), type: "message", role: "assistant", content: [], model: json.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
        textStarted = true;
      }
      if (text) {
        if (textDeltas === 0) {
          textBlockIndex = nextIndex++;
          sse(res, "content_block_start", { type: "content_block_start", index: textBlockIndex, content_block: { type: "text", text: "" } });
        }
        sse(res, "content_block_delta", { type: "content_block_delta", index: textBlockIndex, delta: { type: "text_delta", text } });
        textDeltas += 1;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const deltaToolCall of delta.tool_calls) {
          const key = deltaToolCall.index || 0;
          if (!toolCalls.has(key)) {
            const blockIndex = nextIndex++;
            toolCalls.set(key, {
              blockIndex,
              id: deltaToolCall.id || id("toolu"),
              name: deltaToolCall.function && deltaToolCall.function.name || "tool",
              input: "",
              started: false,
            });
          }
          const call = toolCalls.get(key);
          if (deltaToolCall.id) call.id = deltaToolCall.id;
          if (deltaToolCall.function && deltaToolCall.function.name) call.name = deltaToolCall.function.name;
          if (!call.started) {
            sse(res, "content_block_start", { type: "content_block_start", index: call.blockIndex, content_block: { type: "tool_use", id: call.id, name: call.name, input: {} } });
            call.started = true;
          }
          const argDelta = deltaToolCall.function && deltaToolCall.function.arguments;
          if (argDelta) {
            call.input += argDelta;
            sse(res, "content_block_delta", { type: "content_block_delta", index: call.blockIndex, delta: { type: "input_json_delta", partial_json: argDelta } });
          }
        }
      }
    }
  }
  if (!textStarted) {
    sse(res, "message_start", { type: "message_start", message: { id: id("msg"), type: "message", role: "assistant", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    textBlockIndex = 0;
    textDeltas = 1;
  }
  if (textDeltas) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
  }
  for (const call of toolCalls.values()) {
    sse(res, "content_block_stop", { type: "content_block_stop", index: call.blockIndex });
  }
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: toolCalls.size ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function readResponseText(response) {
  return response.text();
}

function jsonHeaders(response, extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": response.headers.get("x-request-id") || undefined,
    "retry-after": response.headers.get("retry-after") || undefined,
    ...extra,
  };
}

function cleanHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== undefined && value !== null));
}

function contentShape(content) {
  if (typeof content === "string") return { kind: "string", length: content.length };
  if (Array.isArray(content)) {
    return {
      kind: "array",
      length: content.length,
      parts: content.slice(0, 20).map((part) => ({
        type: part && part.type ? String(part.type) : typeof part,
        textLength: typeof (part && part.text) === "string" ? part.text.length : undefined,
        hasImageUrl: Boolean(part && part.image_url),
      })),
    };
  }
  return { kind: content === null ? "null" : typeof content };
}

function chatPayloadShape(payload, bytes) {
  return {
    bytes,
    keys: Object.keys(payload || {}).sort(),
    model: payload && payload.model,
    stream: Boolean(payload && payload.stream),
    max_tokens: payload && payload.max_tokens,
    temperature: payload && payload.temperature,
    toolChoice: payload && payload.tool_choice ? typeof payload.tool_choice : undefined,
    tools: Array.isArray(payload && payload.tools) ? payload.tools.length : 0,
    messages: Array.isArray(payload && payload.messages) ? payload.messages.length : 0,
    messageShapes: Array.isArray(payload && payload.messages)
      ? payload.messages.slice(0, 40).map((message) => ({
        role: message && message.role,
        content: contentShape(message && message.content),
        toolCalls: Array.isArray(message && message.tool_calls) ? message.tool_calls.length : 0,
        toolCallId: message && message.tool_call_id ? true : undefined,
      }))
      : [],
  };
}


function responsesToCompletionPayload(body, model) {
  const payload = {
    model,
    prompt: textFromResponsesInput(body.input) || responsesInputToMessages(body).map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n"),
    stream: Boolean(body.stream),
  };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.user !== undefined) payload.user = body.user;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.max_output_tokens || body.max_tokens) payload.max_tokens = body.max_output_tokens || body.max_tokens;
  return payload;
}

function completionToResponses(completion, model) {
  const text = Array.isArray(completion && completion.choices)
    ? completion.choices.map((choice) => choice && (choice.text || (choice.message && choice.message.content) || "")).filter(Boolean).join("\n")
    : "";
  return {
    id: (completion && completion.id) || id("resp"),
    object: "response",
    created_at: (completion && completion.created) || now(),
    model: (completion && completion.model) || model,
    status: "completed",
    output: text ? [{
      id: id("msg"),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }] : [],
    usage: (completion && completion.usage) || null,
  };
}

async function proxyResponsesViaCompletions(args) {
  const body = parseJsonBody(args.body);
  const model = body.model || args.profile.model;
  const completionPayload = responsesToCompletionPayload(body, model);
  if (completionPayload.stream) {
    args.res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    args.res.end(JSON.stringify({ error: { message: "The completions bridge only supports non-streaming Responses requests." } }));
    return;
  }
  const upstreamBody = Buffer.from(JSON.stringify(completionPayload), "utf8");
  const response = await fetchCompletions({ profile: args.profile, apiKey: args.apiKey, req: args.req, body: upstreamBody });
  const text = await readResponseText(response);
  writeDebugLog(args.debugDir, "upstream-response", {
    traceId: args.traceId,
    protocol: "completions-bridge",
    upstreamUrl: completionsUrl(args.profile.baseUrl),
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    model,
    route: args.route,
    body: text,
  });
  if (!response.ok) {
    args.res.writeHead(response.status, cleanHeaders(jsonHeaders(response)));
    args.res.end(text);
    return;
  }
  let completion;
  try {
    completion = JSON.parse(text);
  } catch (error) {
    args.res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    args.res.end(JSON.stringify({ error: { message: `Failed to parse completions response: ${error.message}` } }));
    return;
  }
  args.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "x-api-switch-upstream-protocol": "completions-bridge",
    "x-api-switch-model-family": args.route.family,
  });
  args.res.end(JSON.stringify(completionToResponses(completion, model)));
}

async function proxyResponsesViaChat(args) {
  const body = parseJsonBody(args.body);
  const model = body.model || args.profile.model;
  const chatPayload = responsesToChatPayload(body, model, { textOnlyImages: args.route && args.route.family === "generic" });
  const upstreamBody = Buffer.from(JSON.stringify(chatPayload), "utf8");
  writeDebugLog(args.debugDir, "upstream-request", {
    traceId: args.traceId,
    protocol: "chat-completions-bridge",
    upstreamUrl: chatCompletionsUrl(args.profile.chatBaseUrl || args.profile.baseUrl),
    profile: args.profile && args.profile.name,
    codexUpstreamProtocol: args.profile && (args.profile.codexUpstreamProtocol || args.profile.upstreamProtocol || ""),
    requestBodyBytes: args.body ? args.body.length : 0,
    payload: chatPayloadShape(chatPayload, upstreamBody.length),
  });
  let response = await fetchChatCompletions({ profile: args.profile, apiKey: args.apiKey, req: args.req, body: upstreamBody });
  if (chatPayload.stream && response.ok && response.headers.get("content-type") && response.headers.get("content-type").includes("text/event-stream")) {
    response = await primeStreamingResponse(response, args.streamingFirstChunkTimeoutMs || 60000, "upstream chat completions stream");
    return pipeChatSseAsResponses({ response, res: args.res, model });
  }

  const text = await readResponseText(response);
  writeDebugLog(args.debugDir, "upstream-response", {
    traceId: args.traceId,
    protocol: "chat-completions-bridge",
    upstreamUrl: chatCompletionsUrl(args.profile.chatBaseUrl || args.profile.baseUrl),
    profile: args.profile && args.profile.name,
    codexUpstreamProtocol: args.profile && (args.profile.codexUpstreamProtocol || args.profile.upstreamProtocol || ""),
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    model,
    route: args.route,
    body: text,
  });
  if (!response.ok) {
    if (args.throwOnRetriableStatus && response.status >= 500) {
      const error = new Error(`Upstream chat completions failed with ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    args.res.writeHead(response.status, cleanHeaders(jsonHeaders(response)));
    args.res.end(text);
    return;
  }
  let chat;
  try {
    chat = JSON.parse(text);
  } catch (error) {
    args.res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    args.res.end(JSON.stringify({ error: { message: `Failed to parse chat completions response: ${error.message}` } }));
    return;
  }
  const payload = chatToResponses(chat, model);
  if (chatPayload.stream) return writeResponsesPayloadAsSse(args.res, payload);
  args.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "x-api-switch-upstream-protocol": "chat-completions-bridge",
    "x-api-switch-model-family": args.route.family,
  });
  args.res.end(JSON.stringify(payload));
}

async function proxyMessagesViaChat(args) {
  if (args.profile && args.profile.claudeUpstreamProtocol === "anthropic-messages") return passthroughMessages(args);
  const body = parseJsonBody(args.body);
  const model = body.model || args.profile.model;
  const chatPayload = anthropicToChatPayload(body, model);
  const upstreamBody = Buffer.from(JSON.stringify(chatPayload), "utf8");
  let response = await fetchChatCompletions({ profile: args.profile, apiKey: args.apiKey, req: args.req, body: upstreamBody });
  if (chatPayload.stream && response.ok && response.headers.get("content-type") && response.headers.get("content-type").includes("text/event-stream")) {
    response = await primeStreamingResponse(response, args.streamingFirstChunkTimeoutMs || 60000, "upstream chat completions stream");
    return pipeChatSseAsAnthropic({ response, res: args.res });
  }
  const text = await readResponseText(response);
  writeDebugLog(args.debugDir, "upstream-response", {
    traceId: args.traceId,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    model,
    route: args.route,
    body: text,
  });
  if (!response.ok) {
    if (args.throwOnRetriableStatus && response.status >= 500) {
      const error = new Error(`Upstream chat completions failed with ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    args.res.writeHead(response.status, cleanHeaders(jsonHeaders(response)));
    args.res.end(text);
    return;
  }
  let chat;
  try {
    chat = JSON.parse(text);
  } catch (error) {
    args.res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    args.res.end(JSON.stringify({ error: { message: `Failed to parse chat completions response: ${error.message}` } }));
    return;
  }
  args.res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "x-api-switch-client": "claude-code",
    "x-api-switch-upstream-protocol": "chat-completions-bridge",
  });
  args.res.end(JSON.stringify(chatToAnthropic(chat, model)));
}

module.exports = {
  anthropicToChatPayload,
  chatToAnthropic,
  chatToResponses,
  proxyMessagesViaChat,
  proxyResponsesViaChat,
  proxyResponsesViaCompletions,
  responsesToChatPayload,
  responsesToCompletionPayload,
};

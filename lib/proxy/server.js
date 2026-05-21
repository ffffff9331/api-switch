"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const { adapterForModel, routeModel } = require("./provider-registry");
const { traceId, writeDebugLog } = require("./debug-log");

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function captureResponse() {
  const chunks = [];
  return {
    chunks,
    statusCode: 200,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      this.headersSent = true;
    },
    write(chunk) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
      else chunks.push(Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      this.ended = true;
    },
    flushTo(res) {
      res.writeHead(this.statusCode || 200, this.headers || {});
      for (const chunk of chunks) res.write(chunk);
      res.end();
    },
  };
}

function rewriteJsonBody(body, updates = {}) {
  if (!body || !Object.keys(updates).length) return body;
  try {
    const payload = JSON.parse(body.toString("utf8"));
    for (const [key, value] of Object.entries(updates)) {
      if (typeof value === "string" && value) payload[key] = value;
    }
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function parseJsonBuffer(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return extractText(value.content);
  return "";
}

const LOCAL_COMPACTION_PREFIX = "api-switch-local-compaction:v1:";

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function compactFallbackBody(body, upstreamModel) {
  const payload = parseJsonBuffer(body) || {};
  const inputText = extractText(payload.input);
  const fallbackPayload = {
    ...payload,
    model: upstreamModel || payload.model,
    input: [
      {
        role: "system",
        content:
          "Compact the conversation state for continued coding work. Preserve durable facts, user preferences, decisions, current goals, open tasks, file paths, commands run, errors, and constraints. Return only the compacted state as concise plain text.",
      },
      {
        role: "user",
        content: inputText || JSON.stringify(payload.input || payload),
      },
    ],
    stream: false,
    store: false,
  };
  delete fallbackPayload.previous_response_id;
  return Buffer.from(JSON.stringify(fallbackPayload));
}

function responseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) return extractText(payload.output);
  return "";
}

function localCompactionToken(text) {
  return `${LOCAL_COMPACTION_PREFIX}${base64UrlEncode(JSON.stringify({ text }))}`;
}

function localCompactionText(encryptedContent) {
  if (typeof encryptedContent !== "string" || !encryptedContent.startsWith(LOCAL_COMPACTION_PREFIX)) return "";
  try {
    const payload = JSON.parse(base64UrlDecode(encryptedContent.slice(LOCAL_COMPACTION_PREFIX.length)));
    return typeof payload.text === "string" ? payload.text : "";
  } catch {
    return "";
  }
}

function decodeMaybeBase64Text(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidates = [value.trim()];
  // Older development builds briefly returned raw base64/base64url text as
  // encrypted_content.  OpenAI-compatible upstreams cannot decrypt that value,
  // so recover a useful summary when possible and otherwise omit it.
  for (const candidate of candidates) {
    for (const encoding of ["base64url", "base64"]) {
      try {
        const decoded = Buffer.from(candidate, encoding).toString("utf8").trim();
        if (!decoded || /\u0000/.test(decoded)) continue;
        const printable = decoded.replace(/[\t\n\r -~]/g, "");
        if (printable.length > Math.max(8, decoded.length / 5)) continue;
        try {
          const parsed = JSON.parse(decoded);
          const text = extractText(parsed);
          if (text) return text;
          if (typeof parsed.summary === "string") return parsed.summary;
          if (typeof parsed.text === "string") return parsed.text;
        } catch {
          // Plain decoded text is fine.
        }
        return decoded;
      } catch {
        // Try the next encoding.
      }
    }
  }
  return "";
}

function legacyCompactionMessage(encryptedContent) {
  const text = localCompactionText(encryptedContent) || decodeMaybeBase64Text(encryptedContent);
  const suffix = text ? `\n${text}` : " The original encrypted_content was invalid legacy local state and was omitted.";
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `Previous local compaction content:${suffix}` }],
  };
}

function legacyCompactionContentPart(encryptedContent) {
  const text = localCompactionText(encryptedContent) || decodeMaybeBase64Text(encryptedContent);
  const suffix = text ? `\n${text}` : " The original encrypted_content was invalid legacy local state and was omitted.";
  return { type: "input_text", text: `Previous local compaction content:${suffix}` };
}

function compactFallbackResponse(payload) {
  const text = responseText(payload) || JSON.stringify(payload);
  return {
    id: `resp_compact_${Date.now().toString(36)}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      {
        id: `cmp_${Date.now().toString(36)}`,
        type: "compaction",
        encrypted_content: localCompactionToken(text),
      },
    ],
    usage: payload && payload.usage ? payload.usage : undefined,
  };
}

function expandLocalCompactionItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type !== "compaction") return item;
  const text = localCompactionText(item.encrypted_content);
  if (!text) return item;
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `Compacted conversation state:\n${text}` }],
  };
}

function sanitizeNestedCompactionValue(value) {
  if (!value || typeof value !== "object") return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      if (item && typeof item === "object" && typeof item.encrypted_content === "string") {
        changed = true;
        return legacyCompactionContentPart(item.encrypted_content);
      }
      const nested = sanitizeNestedCompactionValue(item);
      if (nested.changed) changed = true;
      return nested.value;
    });
    return { value: next, changed };
  }
  if (typeof value.encrypted_content === "string") {
    return { value: legacyCompactionContentPart(value.encrypted_content), changed: true };
  }
  let changed = false;
  const next = { ...value };
  for (const key of Object.keys(next)) {
    const nested = sanitizeNestedCompactionValue(next[key]);
    if (nested.changed) {
      next[key] = nested.value;
      changed = true;
    }
  }
  return { value: next, changed };
}

function sanitizeInputCompactionItem(item) {
  if (!item || typeof item !== "object") return { value: item, changed: false };
  const expanded = expandLocalCompactionItem(item);
  if (expanded !== item) return { value: expanded, changed: true };
  if (typeof item.encrypted_content === "string" || String(item.type || "").includes("compaction")) {
    return { value: legacyCompactionMessage(item.encrypted_content), changed: true };
  }
  return sanitizeNestedCompactionValue(item);
}

function sanitizeCompactionsInBody(body) {
  const payload = parseJsonBuffer(body);
  if (!payload || typeof payload !== "object") return body;
  let changed = false;
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item) => {
      const sanitized = sanitizeInputCompactionItem(item);
      if (sanitized.changed) changed = true;
      return sanitized.value;
    });
  }
  // Defense in depth: upstreams must never receive local or legacy
  // encrypted_content anywhere in the request payload.
  for (const key of Object.keys(payload)) {
    if (key === "input") continue;
    const sanitized = sanitizeNestedCompactionValue(payload[key]);
    if (sanitized.changed) {
      payload[key] = sanitized.value;
      changed = true;
    }
  }
  return changed ? Buffer.from(JSON.stringify(payload)) : body;
}

function sendWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length < 65536) {
    header.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0);
    header.push((body.length / 0x1000000) & 0xff, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff);
  }
  socket.write(Buffer.concat([Buffer.from(header), body]));
}

function sendWebSocketText(socket, text) {
  sendWebSocketFrame(socket, 0x1, Buffer.from(String(text)));
}

function closeWebSocket(socket, code = 1000, reason = "") {
  const reasonBytes = Buffer.from(String(reason));
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  sendWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

function createWebSocketResponse(socket) {
  return {
    statusCode: 200,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
      this.headersSent = true;
      if (status >= 400) {
        sendWebSocketText(socket, JSON.stringify({ type: "error", status, headers: this.headers }));
      }
    },
    write(chunk) {
      if (chunk === undefined || chunk === null) return;
      const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
      if (text) sendWebSocketText(socket, text);
    },
    end(chunk) {
      if (chunk) this.write(chunk);
    },
  };
}

function createWebSocketFrameParser({ onText, onClose, onPing }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        offset += 8;
        if (high !== 0) throw new Error("WebSocket frame is too large.");
        length = low;
      }
      if (!masked) throw new Error("Client WebSocket frames must be masked.");
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }

      if (opcode === 0x8) {
        onClose(payload);
        return;
      }
      if (opcode === 0x9) {
        onPing(payload);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          onText(payload.toString("utf8"));
        } else {
          fragmentOpcode = opcode;
          fragments = [payload];
        }
        continue;
      }
      if (opcode === 0x0 && fragments.length) {
        fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          fragmentOpcode = 0;
          onText(message);
        }
        continue;
      }
      if (fragmentOpcode) {
        throw new Error("Unexpected WebSocket continuation state.");
      }
    }
  };
}

async function proxyWithFallback({ routes, getApiKey, adapterForProfile, requestArgs, res, recordAttempt }) {
  let lastCapture = null;
  for (let index = 0; index < routes.length; index += 1) {
    const routeTarget = routes[index];
    const profile = routeTarget.profile;
    const capture = captureResponse();
    lastCapture = capture;
    const adapter = adapterForProfile(routeTarget);
    const startedAt = Date.now();
    try {
      await requestArgs.invoke(adapter, routeTarget, getApiKey(profile), capture);
      const status = capture.statusCode || 200;
      if (recordAttempt) recordAttempt(routeTarget, status, Date.now() - startedAt, index);
      if (status < 500 || index === routes.length - 1) {
        capture.flushTo(res);
        return { routeTarget, status };
      }
    } catch (error) {
      if (recordAttempt) recordAttempt(routeTarget, 500, Date.now() - startedAt, index, error);
      if (index === routes.length - 1) throw error;
    }
  }
  if (lastCapture) lastCapture.flushTo(res);
  return null;
}

async function proxyResponsesBody({ options, req, res, urlPath, client, profile, fallbackProfiles, body }) {
  const requestTraceId = traceId();
  let payloadModel = "";
  let requestStream = false;
  try {
    const parsedBody = JSON.parse(body.toString("utf8"));
    payloadModel = parsedBody.model || "";
    requestStream = parsedBody.stream === true;
  } catch {
    // Leave model empty; upstream will validate body again.
  }
  const upstreamRequestBody = sanitizeCompactionsInBody(body);
  const routeTargets = buildRouteTargets({
    client,
    requestedModel: payloadModel,
    activeProfile: profile,
    fallbackProfiles,
    resolveModelRoute: options.resolveModelRoute || (() => null),
  });
  const primaryTarget = routeTargets[0];
  const route = routeModel(primaryTarget.upstreamModel || primaryTarget.profile.model);
  const startedAt = Date.now();
  writeDebugLog(options.debugDir, "request", {
    traceId: requestTraceId,
    method: req.method,
    path: urlPath,
    transport: req.transport || "http",
    model: payloadModel || profile.model,
    upstreamModel: primaryTarget.upstreamModel,
    route,
    profile: primaryTarget.profile.name,
    mapped: primaryTarget.mapped,
    bodyBytes: body ? body.length : 0,
    contentType: req.headers["content-type"] || "",
  });
  try {
    let result;
    if (requestStream) {
      let lastError = null;
      for (let index = 0; index < routeTargets.length; index += 1) {
        const candidate = routeTargets[index];
        const candidateRoute = routeModel(candidate.upstreamModel || candidate.profile.model);
        const adapter = adapterForModel(candidate.upstreamModel || candidate.profile.model);
        const startedAttempt = Date.now();
        try {
          const args = {
            profile: candidate.profile,
            apiKey: options.getApiKey(candidate.profile),
            req,
            res,
            route: candidateRoute,
            body: rewriteJsonBody(upstreamRequestBody, { model: candidate.upstreamModel }),
            debugDir: options.debugDir,
            traceId: requestTraceId,
            recordRequest: options.recordRequest,
            throwOnRetriableStatus: index < routeTargets.length - 1,
          };
          await adapter.proxyResponses(args);
          if (options.recordRequest) {
            options.recordRequest({
              traceId: requestTraceId,
              status: res.statusCode || 200,
              model: payloadModel || candidate.profile.model,
              upstreamModel: candidate.upstreamModel || candidate.profile.model,
              family: candidateRoute.family,
              profile: candidate.profile.name,
              durationMs: Date.now() - startedAttempt,
              ok: (res.statusCode || 200) < 400,
              fallbackIndex: index,
              client,
              mapped: candidate.mapped,
            });
          }
          result = { routeTarget: candidate, status: res.statusCode || 200 };
          break;
        } catch (error) {
          lastError = error;
          if (options.recordRequest) {
            options.recordRequest({
              traceId: requestTraceId,
              status: error.status || 500,
              model: payloadModel || candidate.profile.model,
              upstreamModel: candidate.upstreamModel || candidate.profile.model,
              family: candidateRoute.family,
              profile: candidate.profile.name,
              durationMs: Date.now() - startedAttempt,
              ok: false,
              fallbackIndex: index,
              client,
              mapped: candidate.mapped,
              error: error.message,
            });
          }
          if (res.headersSent || index === routeTargets.length - 1) throw error;
        }
      }
      if (!result && lastError) throw lastError;
    } else {
      result = await proxyWithFallback({
        routes: routeTargets,
        getApiKey: options.getApiKey,
        adapterForProfile: (candidate) => adapterForModel(candidate.upstreamModel || candidate.profile.model),
        requestArgs: {
          async invoke(adapter, candidate, apiKey, candidateRes) {
            const candidateRoute = routeModel(candidate.upstreamModel || candidate.profile.model);
            return adapter.proxyResponses({
              profile: candidate.profile,
              apiKey,
              req,
              res: candidateRes,
              route: candidateRoute,
              body: rewriteJsonBody(upstreamRequestBody, { model: candidate.upstreamModel }),
              debugDir: options.debugDir,
              traceId: requestTraceId,
              recordRequest: options.recordRequest,
            });
          },
        },
        res,
        recordAttempt: (candidate, status, durationMs, fallbackIndex, error) => {
          if (!options.recordRequest) return;
          options.recordRequest({
            traceId: requestTraceId,
            status,
            model: payloadModel || candidate.profile.model,
            upstreamModel: candidate.upstreamModel || candidate.profile.model,
            family: routeModel(candidate.upstreamModel || candidate.profile.model).family,
            profile: candidate.profile.name,
            durationMs,
            ok: status < 400,
            fallbackIndex,
            client,
            mapped: candidate.mapped,
            error: error ? error.message : undefined,
          });
        },
      });
    }
    if (options.recordRequest) {
      const resultTarget = result && result.routeTarget ? result.routeTarget : primaryTarget;
      const resultRoute = routeModel(resultTarget.upstreamModel || resultTarget.profile.model);
      options.recordRequest({
        traceId: requestTraceId,
        status: res.statusCode || 200,
        model: payloadModel || profile.model,
        upstreamModel: resultTarget.upstreamModel,
        family: resultRoute.family,
        profile: resultTarget.profile.name,
        durationMs: Date.now() - startedAt,
        ok: (res.statusCode || 200) < 400,
        client,
        mapped: resultTarget.mapped,
      });
    }
  } catch (error) {
    if (options.recordRequest) {
      options.recordRequest({
        traceId: requestTraceId,
        status: 500,
        model: payloadModel || profile.model,
        upstreamModel: primaryTarget.upstreamModel,
        family: route.family,
        profile: primaryTarget.profile.name,
        durationMs: Date.now() - startedAt,
        ok: false,
        client,
        mapped: primaryTarget.mapped,
        error: error.message,
      });
    }
    throw error;
  }
}

function handleResponsesWebSocketUpgrade(options, req, socket) {
  const url = new URL(req.url, `http://${options.host}:${options.port}`);
  if (url.pathname !== "/v1/responses") {
    socket.write("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  const client = "codex";
  const profile = options.getActiveProfile(client);
  if (!profile) {
    socket.write("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    socket.destroy();
    return true;
  }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n"));

  const fallbackProfiles = typeof options.getFallbackProfiles === "function" ? options.getFallbackProfiles(client) : [];
  const wsReq = {
    method: "POST",
    headers: {
      ...req.headers,
      "content-type": req.headers["content-type"] || "application/json",
      accept: req.headers.accept || "text/event-stream",
    },
    transport: "websocket",
  };
  const wsRes = createWebSocketResponse(socket);
  const parse = createWebSocketFrameParser({
    onText: async (message) => {
      try {
        await proxyResponsesBody({
          options,
          req: wsReq,
          res: wsRes,
          urlPath: "/v1/responses",
          client,
          profile,
          fallbackProfiles,
          body: Buffer.from(message),
        });
      } catch (error) {
        sendWebSocketText(socket, JSON.stringify({ type: "error", error: error.message }));
      }
    },
    onClose: () => closeWebSocket(socket),
    onPing: (payload) => sendWebSocketFrame(socket, 0xA, payload),
  });
  socket.on("data", (chunk) => {
    try {
      parse(chunk);
    } catch (error) {
      sendWebSocketText(socket, JSON.stringify({ type: "error", error: error.message }));
      closeWebSocket(socket, 1002, "Protocol error");
    }
  });
  return true;
}

function buildRouteTargets({ client, requestedModel, activeProfile, fallbackProfiles, resolveModelRoute }) {
  const primary = resolveModelRoute(client, requestedModel, activeProfile) || {};
  const profile = primary.profile || activeProfile;
  const upstreamModel = primary.upstreamModel || requestedModel || profile.model;
  const fallbacks = fallbackProfiles
    .filter((item) => item && item.name !== profile.name)
    .map((fallbackProfile) => ({
      profile: fallbackProfile,
      upstreamModel: fallbackProfile.model || requestedModel,
      requestedModel,
      mapped: false,
    }));
  return [{ profile, upstreamModel, requestedModel, mapped: Boolean(primary.mapped) }].concat(fallbacks);
}

function createCodexClientAdapter(options) {
  return {
    name: "codex",
    async handle(req, res, url) {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, activeProfile: options.currentProfileName() || null, client: "codex" });
        return true;
      }

      const client = url.pathname === "/v1/messages" ? "claude-code" : "codex";
      const profile = options.getActiveProfile(client);
      if (!profile) {
        sendJson(res, 400, { error: "No active proxy upstream target. Choose a relay profile in API Switch first." });
        return true;
      }
      const fallbackProfiles = typeof options.getFallbackProfiles === "function" ? options.getFallbackProfiles(client) : [];
      const upstreamForProfile = adapterForModel(profile.model);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        await upstreamForProfile.proxyModels({ profile, apiKey: options.getApiKey(profile), res });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        const requestTraceId = traceId();
        let payloadModel = "";
        let body;
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          body = Buffer.concat(chunks);
          const parsedBody = JSON.parse(body.toString("utf8"));
          payloadModel = parsedBody.model || "";
        } catch {
          // Leave model empty; upstream will validate body again.
        }
        const routeTargets = buildRouteTargets({
          client,
          requestedModel: payloadModel,
          activeProfile: profile,
          fallbackProfiles,
          resolveModelRoute: options.resolveModelRoute || (() => null),
        });
        const primaryTarget = routeTargets[0];
        const route = routeModel(primaryTarget.upstreamModel || primaryTarget.profile.model);
        const startedAt = Date.now();
        writeDebugLog(options.debugDir, "request", {
          traceId: requestTraceId,
          method: req.method,
          path: url.pathname,
          model: payloadModel || profile.model,
          upstreamModel: primaryTarget.upstreamModel,
          route,
          profile: primaryTarget.profile.name,
          mapped: primaryTarget.mapped,
          bodyBytes: body ? body.length : 0,
          contentType: req.headers["content-type"] || "",
        });

        try {
          const result = await proxyWithFallback({
            routes: routeTargets,
            getApiKey: options.getApiKey,
            adapterForProfile: (candidate) => adapterForModel(candidate.upstreamModel || candidate.profile.model),
            requestArgs: {
              async invoke(adapter, candidate, apiKey, candidateRes) {
                const candidateRoute = routeModel(candidate.upstreamModel || candidate.profile.model);
                const capture = captureResponse();
                await adapter.proxyResponses({
                  profile: candidate.profile,
                  apiKey,
                  req,
                  res: capture,
                  route: candidateRoute,
                  body: compactFallbackBody(body, candidate.upstreamModel),
                  debugDir: options.debugDir,
                  traceId: requestTraceId,
                  recordRequest: options.recordRequest,
                });
                if ((capture.statusCode || 200) >= 400) {
                  capture.flushTo(candidateRes);
                  return;
                }
                const payload = parseJsonBuffer(Buffer.concat(capture.chunks || []));
                const compacted = compactFallbackResponse(payload);
                candidateRes.writeHead(200, {
                  "content-type": "application/json; charset=utf-8",
                  "x-api-switch-compact-bridge": "local-state",
                });
                candidateRes.end(JSON.stringify(compacted));
              },
            },
            res,
            recordAttempt: (candidate, status, durationMs, fallbackIndex, error) => {
              if (!options.recordRequest) return;
              options.recordRequest({
                traceId: requestTraceId,
                status,
                model: payloadModel || candidate.profile.model,
                upstreamModel: candidate.upstreamModel || candidate.profile.model,
                family: routeModel(candidate.upstreamModel || candidate.profile.model).family,
                profile: candidate.profile.name,
                durationMs,
                ok: status < 400,
                fallbackIndex,
                client,
                mapped: candidate.mapped,
                error: error ? error.message : undefined,
              });
            },
          });
          if (options.recordRequest) {
            const resultTarget = result && result.routeTarget ? result.routeTarget : primaryTarget;
            const resultRoute = routeModel(resultTarget.upstreamModel || resultTarget.profile.model);
            options.recordRequest({
              traceId: requestTraceId,
              status: res.statusCode || 200,
              model: payloadModel || profile.model,
              upstreamModel: resultTarget.upstreamModel,
              family: resultRoute.family,
              profile: resultTarget.profile.name,
              durationMs: Date.now() - startedAt,
              ok: (res.statusCode || 200) < 400,
              client,
              mapped: resultTarget.mapped,
            });
          }
        } catch (error) {
          if (options.recordRequest) {
            options.recordRequest({
              traceId: requestTraceId,
              status: 500,
              model: payloadModel || profile.model,
              upstreamModel: primaryTarget.upstreamModel,
              family: route.family,
              profile: primaryTarget.profile.name,
              durationMs: Date.now() - startedAt,
              ok: false,
              client,
              mapped: primaryTarget.mapped,
              error: error.message,
            });
          }
          throw error;
        }
        return true;
      }

      if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/v1/messages")) {
        const requestTraceId = traceId();
        let payloadModel = "";
        let requestStream = false;
        let body;
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          body = Buffer.concat(chunks);
          const parsedBody = JSON.parse(body.toString("utf8"));
          payloadModel = parsedBody.model || "";
          requestStream = parsedBody.stream === true;
        } catch {
          // Leave model empty; upstream will validate body again.
        }
        if (url.pathname === "/v1/responses") {
          await proxyResponsesBody({
            options,
            req,
            res,
            urlPath: url.pathname,
            client,
            profile,
            fallbackProfiles,
            body,
          });
          return true;
        }
        const routeTargets = buildRouteTargets({
          client,
          requestedModel: payloadModel,
          activeProfile: profile,
          fallbackProfiles,
          resolveModelRoute: options.resolveModelRoute || (() => null),
        });
        const primaryTarget = routeTargets[0];
        const route = routeModel(primaryTarget.upstreamModel || primaryTarget.profile.model);
        const upstreamBody = rewriteJsonBody(body, { model: primaryTarget.upstreamModel });
        const startedAt = Date.now();
        writeDebugLog(options.debugDir, "request", {
          traceId: requestTraceId,
          method: req.method,
          path: url.pathname,
          model: payloadModel || profile.model,
          upstreamModel: primaryTarget.upstreamModel,
          route,
          profile: primaryTarget.profile.name,
          mapped: primaryTarget.mapped,
          bodyBytes: body ? body.length : 0,
          contentType: req.headers["content-type"] || "",
        });
        try {
          let result;
          if (requestStream) {
            let lastError = null;
            for (let index = 0; index < routeTargets.length; index += 1) {
              const candidate = routeTargets[index];
              const candidateRoute = routeModel(candidate.upstreamModel || candidate.profile.model);
              const adapter = adapterForModel(candidate.upstreamModel || candidate.profile.model);
              const startedAttempt = Date.now();
              try {
                const args = {
                  profile: candidate.profile,
                  apiKey: options.getApiKey(candidate.profile),
                  req,
                  res,
                  route: candidateRoute,
                  body: rewriteJsonBody(body, { model: candidate.upstreamModel }),
                  debugDir: options.debugDir,
                  traceId: requestTraceId,
                  recordRequest: options.recordRequest,
                  throwOnRetriableStatus: index < routeTargets.length - 1,
                };
                if (url.pathname === "/v1/messages") await adapter.proxyMessages(args);
                else await adapter.proxyResponses(args);
                if (options.recordRequest) {
                  options.recordRequest({
                    traceId: requestTraceId,
                    status: res.statusCode || 200,
                    model: payloadModel || candidate.profile.model,
                    upstreamModel: candidate.upstreamModel || candidate.profile.model,
                    family: candidateRoute.family,
                    profile: candidate.profile.name,
                    durationMs: Date.now() - startedAttempt,
                    ok: (res.statusCode || 200) < 400,
                    fallbackIndex: index,
                    client,
                    mapped: candidate.mapped,
                  });
                }
                result = { routeTarget: candidate, status: res.statusCode || 200 };
                break;
              } catch (error) {
                lastError = error;
                if (options.recordRequest) {
                  options.recordRequest({
                    traceId: requestTraceId,
                    status: error.status || 500,
                    model: payloadModel || candidate.profile.model,
                    upstreamModel: candidate.upstreamModel || candidate.profile.model,
                    family: candidateRoute.family,
                    profile: candidate.profile.name,
                    durationMs: Date.now() - startedAttempt,
                    ok: false,
                    fallbackIndex: index,
                    client,
                    mapped: candidate.mapped,
                    error: error.message,
                  });
                }
                if (res.headersSent || index === routeTargets.length - 1) throw error;
              }
            }
            if (!result && lastError) throw lastError;
          } else {
            result = await proxyWithFallback({
              routes: routeTargets,
              getApiKey: options.getApiKey,
              adapterForProfile: (candidate) => {
                return adapterForModel(candidate.upstreamModel || candidate.profile.model);
              },
              requestArgs: {
                async invoke(adapter, candidate, apiKey, candidateRes) {
                  const candidateRoute = routeModel(candidate.upstreamModel || candidate.profile.model);
                  const args = {
                    profile: candidate.profile,
                    apiKey,
                    req,
                    res: candidateRes,
                    route: candidateRoute,
                    body: rewriteJsonBody(body, { model: candidate.upstreamModel }),
                    debugDir: options.debugDir,
                    traceId: requestTraceId,
                    recordRequest: options.recordRequest,
                  };
                  if (url.pathname === "/v1/messages") return adapter.proxyMessages(args);
                  return adapter.proxyResponses(args);
                },
              },
              res,
              recordAttempt: (candidate, status, durationMs, fallbackIndex, error) => {
                if (!options.recordRequest) return;
                options.recordRequest({
                  traceId: requestTraceId,
                  status,
                  model: payloadModel || candidate.profile.model,
                  upstreamModel: candidate.upstreamModel || candidate.profile.model,
                  family: routeModel(candidate.upstreamModel || candidate.profile.model).family,
                  profile: candidate.profile.name,
                  durationMs,
                  ok: status < 400,
                  fallbackIndex,
                  client,
                  mapped: candidate.mapped,
                  error: error ? error.message : undefined,
                });
              },
            });
          }
          if (options.recordRequest) {
            const resultTarget = result && result.routeTarget ? result.routeTarget : primaryTarget;
            const resultRoute = routeModel(resultTarget.upstreamModel || resultTarget.profile.model);
            options.recordRequest({
              traceId: requestTraceId,
              status: res.statusCode || 200,
              model: payloadModel || profile.model,
              upstreamModel: resultTarget.upstreamModel,
              family: resultRoute.family,
              profile: resultTarget.profile.name,
              durationMs: Date.now() - startedAt,
              ok: (res.statusCode || 200) < 400,
              client,
              mapped: resultTarget.mapped,
            });
          }
        } catch (error) {
          if (options.recordRequest) {
            options.recordRequest({
              traceId: requestTraceId,
              status: 500,
              model: payloadModel || profile.model,
              upstreamModel: primaryTarget.upstreamModel,
              family: route.family,
              profile: primaryTarget.profile.name,
              durationMs: Date.now() - startedAt,
              ok: false,
              client,
              mapped: primaryTarget.mapped,
              error: error.message,
            });
          }
          throw error;
        }
        return true;
      }

      return false;
    },
  };
}

function createProxyHandler(options) {
  const adapters = [createCodexClientAdapter(options)];

  return async (req, res) => {
    try {
      const url = new URL(req.url, `http://${options.host}:${options.port}`);
      for (const adapter of adapters) {
        if (await adapter.handle(req, res, url)) return;
      }
      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 400, { error: error.message });
      else res.end();
    }
  };
}

function createProxyServer(options) {
  const handler = createProxyHandler(options);
  const server = http.createServer(handler);
  server.on("upgrade", (req, socket) => {
    try {
      if (handleResponsesWebSocketUpgrade(options, req, socket)) return;
      socket.destroy();
    } catch {
      socket.destroy();
    }
  });
  return server;
}

function startProxyServer(options) {
  const server = createProxyServer(options);
  server.on("error", (error) => {
    if (error && error.code === "EADDRINUSE") {
      console.error(`API Switch proxy port is already in use: http://${options.host}:${options.port}/v1`);
      console.error("Stop the existing API Switch process or start this one with --port <port>.");
      process.exit(1);
    }
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    console.log(`API Switch proxy: http://${options.host}:${address.port}/v1`);
  });
  return server;
}

module.exports = {
  createProxyHandler,
  createProxyServer,
  handleResponsesWebSocketUpgrade,
  startProxyServer,
};

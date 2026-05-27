"use strict";

const { writeDebugLog } = require("./debug-log");

function joinPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith(suffix)) pathname = `${pathname}${suffix}`;
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function modelsUrl(baseUrl) {
  return joinPath(baseUrl, "/models");
}

function responsesUrl(baseUrl) {
  return joinPath(baseUrl, "/responses");
}

function responsesCompactUrl(baseUrl) {
  return joinPath(baseUrl, "/responses/compact");
}

function chatCompletionsUrl(baseUrl) {
  return joinPath(baseUrl, "/chat/completions");
}

function completionsUrl(baseUrl) {
  return joinPath(baseUrl, "/completions");
}

function messagesUrl(baseUrl) {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  const suffix = pathname.endsWith("/v1") ? "/messages" : "/v1/messages";
  return joinPath(baseUrl, suffix);
}

async function fetchWithTimeout(url, init, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(value) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, date - Date.now());
}

async function fetchWithRetry(url, init, options = {}) {
  const retries = options.retries === undefined ? 1 : Number(options.retries);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, options);
      const shouldRetry = response.status >= 500 || response.status === 429;
      if (!shouldRetry || attempt === retries) return response;
      const delayMs = response.status === 429 ? Math.min(retryAfterMs(response.headers.get("retry-after")), 5000) : 0;
      await response.arrayBuffer();
      if (delayMs) await sleep(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
  }
  throw lastError || new Error("Upstream request failed.");
}

function pipeRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > 50 * 1024 * 1024) {
        rejected = true;
        req.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks, total));
    });
    req.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function passthroughTraceHeaders(response, headers) {
  for (const name of ["x-request-id", "x-correlation-id", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

function clientHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

function openaiRequestHeaders(req, apiKey) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers.accept || "application/json",
  };
  for (const name of ["openai-organization", "openai-project", "openai-beta"]) {
    const value = clientHeader(req, name);
    if (value) headers[name] = value;
  }
  return headers;
}

function anthropicRequestHeaders(req, apiKey) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "anthropic-version": clientHeader(req, "anthropic-version") || "2023-06-01",
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers.accept || "application/json",
  };
  for (const name of ["anthropic-beta", "anthropic-dangerous-direct-browser-access"]) {
    const value = clientHeader(req, name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function passthroughModels({ profile, apiKey, res }) {
  const response = await fetchWithRetry(modelsUrl(profile.baseUrl), {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  }, { retries: 1, timeoutMs: 30000 });
  const text = await response.text();
  res.writeHead(response.status, passthroughTraceHeaders(response, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
  }));
  res.end(text);
}

async function passthroughResponses({ profile, apiKey, req, res, route, body, throwOnRetriableStatus, debugDir, traceId }) {
  const requestBody = body || (await pipeRequestBody(req));
  const startedAt = Date.now();
  const upstreamUrl = responsesUrl(profile.baseUrl);
  const response = await fetchWithRetry(upstreamUrl, {
    method: "POST",
    headers: openaiRequestHeaders(req, apiKey),
    body: requestBody,
  }, { retries: 0, timeoutMs: 300000 });
  const upstreamMs = Date.now() - startedAt;
  writeDebugLog(debugDir, "upstream", {
    traceId,
    protocol: "responses",
    upstreamUrl,
    status: response.status,
    upstreamMs,
    profile: profile && profile.name,
    codexUpstreamProtocol: profile && (profile.codexUpstreamProtocol || profile.upstreamProtocol || ""),
  });
  if (throwOnRetriableStatus && response.status >= 500) {
    await response.arrayBuffer();
    const error = new Error(`Upstream responses failed with ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const headers = passthroughTraceHeaders(response, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": response.headers.get("cache-control") || "no-cache",
    connection: "keep-alive",
    "x-api-switch-model-family": route.family,
    "x-api-switch-upstream-protocol": route.upstreamProtocol,
    "x-api-switch-upstream-ms": String(upstreamMs),
  });

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

async function passthroughResponsesCompact({ profile, apiKey, req, res, route, body, throwOnRetriableStatus, debugDir, traceId }) {
  const requestBody = body || (await pipeRequestBody(req));
  const startedAt = Date.now();
  const upstreamUrl = responsesCompactUrl(profile.baseUrl);
  const response = await fetchWithRetry(upstreamUrl, {
    method: "POST",
    headers: openaiRequestHeaders(req, apiKey),
    body: requestBody,
  }, { retries: 0, timeoutMs: 300000 });
  const upstreamMs = Date.now() - startedAt;
  writeDebugLog(debugDir, "upstream", {
    traceId,
    protocol: "responses-compact",
    upstreamUrl,
    status: response.status,
    upstreamMs,
    profile: profile && profile.name,
    codexUpstreamProtocol: profile && (profile.codexUpstreamProtocol || profile.upstreamProtocol || ""),
  });
  if (throwOnRetriableStatus && response.status >= 500) {
    await response.arrayBuffer();
    const error = new Error(`Upstream responses compact failed with ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  const headers = passthroughTraceHeaders(response, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": response.headers.get("cache-control") || "no-cache",
    connection: "keep-alive",
    "x-api-switch-model-family": route.family,
    "x-api-switch-upstream-protocol": route.upstreamProtocol,
    "x-api-switch-upstream-ms": String(upstreamMs),
  });

  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

async function fetchChatCompletions({ profile, apiKey, req, body, retries = 0, timeoutMs = 300000 }) {
  return fetchWithRetry(chatCompletionsUrl(profile.chatBaseUrl || profile.baseUrl), {
    method: "POST",
    headers: openaiRequestHeaders(req, apiKey),
    body,
  }, { retries, timeoutMs });
}

async function fetchCompletions({ profile, apiKey, req, body, retries = 0, timeoutMs = 300000 }) {
  return fetchWithRetry(completionsUrl(profile.baseUrl), {
    method: "POST",
    headers: openaiRequestHeaders(req, apiKey),
    body,
  }, { retries, timeoutMs });
}

async function passthroughMessages({ profile, apiKey, req, res, body, throwOnRetriableStatus }) {
  const requestBody = body || (await pipeRequestBody(req));
  const startedAt = Date.now();
  const response = await fetchWithRetry(messagesUrl(profile.anthropicBaseUrl || profile.baseUrl), {
    method: "POST",
    headers: anthropicRequestHeaders(req, apiKey),
    body: requestBody,
  }, { retries: 0, timeoutMs: 300000 });
  const upstreamMs = Date.now() - startedAt;
  if (throwOnRetriableStatus && response.status >= 500) {
    await response.arrayBuffer();
    const error = new Error(`Upstream messages failed with ${response.status}.`);
    error.status = response.status;
    throw error;
  }

  res.writeHead(response.status, passthroughTraceHeaders(response, {
    "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": response.headers.get("cache-control") || "no-cache",
    connection: "keep-alive",
    "x-api-switch-client": "claude-code",
    "x-api-switch-upstream-ms": String(upstreamMs),
  }));
  if (!response.body) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    res.write(chunk);
  }
  res.end();
}

module.exports = {
  chatCompletionsUrl,
  completionsUrl,
  fetchChatCompletions,
  fetchCompletions,
  fetchWithRetry,
  pipeRequestBody,
  passthroughModels,
  passthroughMessages,
  passthroughResponses,
  passthroughResponsesCompact,
  responsesCompactUrl,
};

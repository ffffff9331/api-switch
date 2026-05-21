"use strict";

const http = require("node:http");

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
  return http.createServer(handler);
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
  startProxyServer,
};

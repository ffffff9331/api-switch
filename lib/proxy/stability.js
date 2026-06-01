"use strict";

const DEFAULT_STREAMING_FIRST_CHUNK_TIMEOUT_MS = 60000;

function errorCategory(error) {
  if (!error) return "unknown_error";
  if (error.category) return error.category;
  if (error.name === "AbortError") return "upstream_timeout";
  if (error.status) {
    if ([400, 405, 406, 413, 414, 415, 422, 501].includes(Number(error.status))) return "client_request_invalid";
    if (Number(error.status) === 429) return "upstream_429";
    if (Number(error.status) >= 500) return "upstream_5xx";
    if (Number(error.status) >= 400) return "upstream_4xx_retryable";
  }
  const code = error.code || (error.cause && error.cause.code) || "";
  if (/TIMEOUT|ETIMEDOUT/i.test(code) || /timeout/i.test(error.message || "")) return "upstream_timeout";
  if (/terminated|socket|ECONNRESET|UND_ERR|fetch failed|connection failed/i.test(error.message || "")) return "upstream_connect_failed";
  return "proxy_error";
}

function isRetryableError(error) {
  return !["client_request_invalid"].includes(errorCategory(error));
}

function retryableStatus(status) {
  return ![400, 405, 406, 413, 414, 415, 422, 501].includes(Number(status));
}

function retryableStatusForFallback(status) {
  return Number(status) >= 500 || Number(status) === 429 || [401, 403, 404, 408, 409, 451].includes(Number(status));
}

function timeoutError(message, category = "upstream_first_chunk_timeout") {
  const error = new Error(message);
  error.status = 504;
  error.category = category;
  return error;
}

async function primeAsyncIterable(iterable, timeoutMs = DEFAULT_STREAMING_FIRST_CHUNK_TIMEOUT_MS, label = "upstream stream") {
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") return iterable;
  if (!timeoutMs) return iterable;
  const iterator = iterable[Symbol.asyncIterator]();
  let timer;
  let first;
  try {
    first = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(timeoutError(`${label} did not produce a first chunk within ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (typeof iterator.return === "function") {
      try {
        Promise.resolve(iterator.return()).catch(() => {});
      } catch {
        // Best effort cleanup.
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!first || first.done) {
    const error = new Error(`${label} ended before producing a first chunk.`);
    error.status = 502;
    error.category = "upstream_stream_ended_before_first_chunk";
    throw error;
  }

  async function* replay() {
    yield first.value;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  return replay();
}

async function primeStreamingResponse(response, timeoutMs, label) {
  if (!response || !response.body) return response;
  const body = await primeAsyncIterable(response.body, timeoutMs, label);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    body,
  };
}

module.exports = {
  DEFAULT_STREAMING_FIRST_CHUNK_TIMEOUT_MS,
  errorCategory,
  isRetryableError,
  primeAsyncIterable,
  primeStreamingResponse,
  retryableStatus,
  retryableStatusForFallback,
};

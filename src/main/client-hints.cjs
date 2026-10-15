'use strict';
const crypto = require('node:crypto');

// 客户端提示（Client Hints / Sec-CH-UA 请求头）与 Datadog RUM 链路追踪头
// 补齐 Chromium/Electron 在网络层缺失的 Sec-CH-UA 请求头，
// 以及补充真实浏览器环境 100% 携带的 Datadog traceparent/tracestate 与 RUM 追踪头。

function clientHintsHeaders(env = {}) {
  const customUa = String(env.userAgent || "").trim();
  // 如果显式设置了非 Chromium 浏览器的自定义 UA（例如 Firefox），则不注入 Chrome 专属客户端提示
  if (customUa && !/Chrome\/[0-9.]+/i.test(customUa)) {
    return null;
  }

  let major = "134";
  let fullVersion = "134.0.6998.88";
  const uaMatch = customUa.match(/Chrome\/([0-9.]+)/i);
  if (uaMatch) {
    fullVersion = uaMatch[1];
    major = fullVersion.split(".")[0];
  } else if (process.versions?.chrome) {
    fullVersion = String(process.versions.chrome);
    major = fullVersion.split(".")[0];
  }

  const brands = `"Chromium";v="${major}", "Not:A-Brand";v="24", "Google Chrome";v="${major}"`;
  let platform = '"Windows"';
  if (env.platform === "MacIntel") {
    platform = '"macOS"';
  } else if (env.platform === "Linux x86_64") {
    platform = '"Linux"';
  }

  return {
    "Sec-CH-UA": brands,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": platform
  };
}

/**
 * 生成真实浏览器 100% 携带的标准 Datadog RUM / APM W3C 链路追踪头
 * 遵循 W3C Trace Context 规范 (traceparent, tracestate) 与 Datadog 专有头。
 */
function datadogTraceHeaders(env = {}) {
  try {
    const traceIdHex128 = crypto.randomBytes(16).toString('hex');
    const spanIdHex64 = crypto.randomBytes(8).toString('hex');
    const traceId64 = traceIdHex128.slice(16);
    const traceIdDec = BigInt('0x' + traceId64).toString(10);
    const spanIdDec = BigInt('0x' + spanIdHex64).toString(10);

    return {
      "traceparent": `00-${traceIdHex128}-${spanIdHex64}-01`,
      "tracestate": `dd=s:1;o:rum;p:${spanIdHex64}`,
      "x-datadog-trace-id": traceIdDec,
      "x-datadog-parent-id": spanIdDec,
      "x-datadog-origin": "rum",
      "x-datadog-sampling-priority": "1"
    };
  } catch {
    return null;
  }
}

const registeredSessions = new WeakSet();

function attachClientHints(session, env = {}) {
  if (!session?.webRequest) return;
  if (registeredSessions.has(session)) return;
  registeredSessions.add(session);

  const filter = { urls: ["http://*/*", "https://*/*"] };
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    try {
      const headers = details.requestHeaders || {};

      // 1. Client Hints 注入
      const hints = clientHintsHeaders(env);
      if (hints) {
        if (!headers["Sec-CH-UA"] && !headers["sec-ch-ua"]) {
          headers["Sec-CH-UA"] = hints["Sec-CH-UA"];
        }
        if (!headers["Sec-CH-UA-Mobile"] && !headers["sec-ch-ua-mobile"]) {
          headers["Sec-CH-UA-Mobile"] = hints["Sec-CH-UA-Mobile"];
        }
        if (!headers["Sec-CH-UA-Platform"] && !headers["sec-ch-ua-platform"]) {
          headers["Sec-CH-UA-Platform"] = hints["Sec-CH-UA-Platform"];
        }
      }

      // 2. Datadog RUM / W3C Traceparent 自动注入（仅针对 API 请求 xhr / fetch）
      const isApiRequest = details.resourceType === 'xhr' || details.resourceType === 'fetch';
      const datadogEnabled = env.datadogRum !== false; // 默认对齐真实浏览器 RUM 行为
      if (isApiRequest && datadogEnabled) {
        const hasTrace = headers["traceparent"] || headers["Traceparent"] || headers["x-datadog-trace-id"];
        if (!hasTrace) {
          const dd = datadogTraceHeaders(env);
          if (dd) {
            headers["traceparent"] = dd["traceparent"];
            headers["tracestate"] = dd["tracestate"];
            headers["x-datadog-trace-id"] = dd["x-datadog-trace-id"];
            headers["x-datadog-parent-id"] = dd["x-datadog-parent-id"];
            headers["x-datadog-origin"] = dd["x-datadog-origin"];
            headers["x-datadog-sampling-priority"] = dd["x-datadog-sampling-priority"];
          }
        }
      }

      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
}

module.exports = { clientHintsHeaders, datadogTraceHeaders, attachClientHints };

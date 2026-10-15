'use strict';

// 客户端提示（Client Hints / Sec-CH-UA 请求头）
// 补齐 Chromium/Electron 在网络层缺失的 Sec-CH-UA 请求头，
// 确保发送的 HTTP 请求与主环境报告的 Chrome 版本和操作系统平台一致。

function clientHintsHeaders(env = {}) {
  const customUa = String(env.userAgent || "").trim();
  // 如果显式设置了非 Chromium 浏览器的自定义 UA（例如 Firefox），则不注入 Chrome 专属客户端提示
  if (customUa && !/Chrome\/[0-9.]+/i.test(customUa)) {
    return null;
  }

  let major = "134";
  const uaMatch = customUa.match(/Chrome\/([0-9]+)/i);
  if (uaMatch) {
    major = uaMatch[1];
  } else if (process.versions?.chrome) {
    major = String(process.versions.chrome).split(".")[0];
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

const registeredSessions = new WeakSet();

function attachClientHints(session, env = {}) {
  if (!session?.webRequest) return;
  if (registeredSessions.has(session)) return;
  registeredSessions.add(session);

  const filter = { urls: ["http://*/*", "https://*/*"] };
  session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    try {
      const hints = clientHintsHeaders(env);
      if (!hints) {
        callback({ requestHeaders: details.requestHeaders });
        return;
      }
      const headers = details.requestHeaders || {};
      if (!headers["Sec-CH-UA"] && !headers["sec-ch-ua"]) {
        headers["Sec-CH-UA"] = hints["Sec-CH-UA"];
      }
      if (!headers["Sec-CH-UA-Mobile"] && !headers["sec-ch-ua-mobile"]) {
        headers["Sec-CH-UA-Mobile"] = hints["Sec-CH-UA-Mobile"];
      }
      if (!headers["Sec-CH-UA-Platform"] && !headers["sec-ch-ua-platform"]) {
        headers["Sec-CH-UA-Platform"] = hints["Sec-CH-UA-Platform"];
      }
      callback({ requestHeaders: headers });
    } catch {
      callback({ requestHeaders: details.requestHeaders });
    }
  });
}

module.exports = { clientHintsHeaders, attachClientHints };


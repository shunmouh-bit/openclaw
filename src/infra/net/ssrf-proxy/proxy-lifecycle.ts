/**
 * High-level lifecycle management for OpenClaw's operator-managed SSRF
 * network proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import type { SsrFProxyConfig } from "./proxy-config-schema.js";

export type SsrFProxyHandle = {
  /** The operator-managed proxy URL injected into process.env. */
  proxyUrl: string;
  /** Alias kept for CLI cleanup tests and logs. */
  injectedProxyUrl: string;
  /** Original proxy-related environment values, restored on stop/crash. */
  envSnapshot: ProxyEnvSnapshot;
  /** Restore process-wide proxy state. */
  stop: () => Promise<void>;
  /** Synchronously restore process-wide proxy state during hard process exit. */
  kill: (signal?: NodeJS.Signals) => void;
};

const PROXY_ENV_KEYS = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const GLOBAL_AGENT_PROXY_KEYS = ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY"] as const;
const GLOBAL_AGENT_FORCE_KEYS = ["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] as const;
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY", "GLOBAL_AGENT_NO_PROXY"] as const;
const ALL_PROXY_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  ...GLOBAL_AGENT_PROXY_KEYS,
  ...GLOBAL_AGENT_FORCE_KEYS,
  ...NO_PROXY_ENV_KEYS,
] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

let globalAgentBootstrapped = false;

export function _resetGlobalAgentBootstrapForTests(): void {
  globalAgentBootstrapped = false;
}

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    GLOBAL_AGENT_HTTP_PROXY: process.env["GLOBAL_AGENT_HTTP_PROXY"],
    GLOBAL_AGENT_HTTPS_PROXY: process.env["GLOBAL_AGENT_HTTPS_PROXY"],
    GLOBAL_AGENT_FORCE_GLOBAL_AGENT: process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
    GLOBAL_AGENT_NO_PROXY: process.env["GLOBAL_AGENT_NO_PROXY"],
  };
}

function injectProxyEnv(proxyUrl: string): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
  for (const key of GLOBAL_AGENT_PROXY_KEYS) {
    process.env[key] = proxyUrl;
  }
  process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"] = "true";
  for (const key of NO_PROXY_ENV_KEYS) {
    process.env[key] = "";
  }
  return snapshot;
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const key of ALL_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreGlobalAgentRuntime(snapshot: ProxyEnvSnapshot): void {
  if (
    typeof global === "undefined" ||
    (global as Record<string, unknown>)["GLOBAL_AGENT"] == null
  ) {
    return;
  }
  const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
  agent["HTTP_PROXY"] = snapshot["GLOBAL_AGENT_HTTP_PROXY"] ?? "";
  agent["HTTPS_PROXY"] = snapshot["GLOBAL_AGENT_HTTPS_PROXY"] ?? "";
  agent["NO_PROXY"] = snapshot["GLOBAL_AGENT_NO_PROXY"] ?? null;
}

function bootstrapNodeHttpStack(proxyUrl: string): void {
  if (!globalAgentBootstrapped) {
    bootstrapGlobalAgent();
    globalAgentBootstrapped = true;
  }

  if (
    typeof global !== "undefined" &&
    (global as Record<string, unknown>)["GLOBAL_AGENT"] != null
  ) {
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    agent["HTTP_PROXY"] = proxyUrl;
    agent["HTTPS_PROXY"] = proxyUrl;
    agent["NO_PROXY"] = process.env["GLOBAL_AGENT_NO_PROXY"];
  }
}

function isSupportedProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:";
  } catch {
    return false;
  }
}

function resolveProxyUrl(config: SsrFProxyConfig | undefined): string | null {
  const candidate = config?.proxyUrl?.trim() || process.env["OPENCLAW_SSRF_PROXY_URL"]?.trim();
  if (!candidate) {
    return null;
  }
  return isSupportedProxyUrl(candidate) ? candidate : null;
}

export async function startSsrFProxy(
  config: SsrFProxyConfig | undefined,
): Promise<SsrFProxyHandle | null> {
  if (config?.enabled !== true) {
    logInfo("ssrf-proxy: disabled - using application-level SSRF guards only");
    return null;
  }

  const proxyUrl = resolveProxyUrl(config);
  if (proxyUrl === null) {
    logWarn(
      "ssrf-proxy: enabled but no HTTP proxy URL is configured; set ssrfProxy.proxyUrl " +
        "or OPENCLAW_SSRF_PROXY_URL to an http:// forward proxy. Using application-level SSRF guards only.",
    );
    return null;
  }

  const startupEnvSnapshot = captureProxyEnv();
  let injectedEnvSnapshot: ProxyEnvSnapshot | null = null;

  const restoreRuntime = (): void => {
    if (injectedEnvSnapshot !== null) {
      restoreProxyEnv(injectedEnvSnapshot);
      injectedEnvSnapshot = null;
    }
    try {
      forceResetGlobalDispatcher();
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset undici dispatcher: ${String(err)}`);
    }
    try {
      restoreGlobalAgentRuntime(startupEnvSnapshot);
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset global-agent: ${String(err)}`);
    }
  };

  try {
    injectedEnvSnapshot = injectProxyEnv(proxyUrl);
    forceResetGlobalDispatcher();
    bootstrapNodeHttpStack(proxyUrl);
  } catch (err) {
    restoreRuntime();
    logWarn(
      `ssrf-proxy: failed to activate external proxy routing - using application-level SSRF guards only. Reason: ${String(err)}`,
    );
    return null;
  }

  logInfo(`ssrf-proxy: routing process HTTP traffic through external proxy ${proxyUrl}`);

  const handle: SsrFProxyHandle = {
    proxyUrl,
    injectedProxyUrl: proxyUrl,
    envSnapshot: injectedEnvSnapshot,
    stop: async () => {
      restoreRuntime();
    },
    kill: () => {
      restoreRuntime();
    },
  };

  return handle;
}

export async function stopSsrFProxy(handle: SsrFProxyHandle | null): Promise<void> {
  if (!handle) {
    return;
  }
  await handle.stop();
}

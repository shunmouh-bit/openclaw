/**
 * High-level lifecycle management for OpenClaw's operator-managed SSRF
 * network proxy routing.
 *
 * OpenClaw does not spawn or configure the filtering proxy. When enabled, it
 * routes process-wide HTTP clients through the configured forward proxy URL and
 * restores the previous process state on shutdown.
 */

import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import { logInfo, logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import type { SsrFProxyConfig } from "./proxy-config-schema.js";

type ClientRequestFunction = typeof http.request;
type ClientRequestCallback = (res: http.IncomingMessage) => void;
type ClientRequestArg = string | URL | http.RequestOptions;
type ClientRequestRestArg = http.RequestOptions | ClientRequestCallback | undefined;
type HttpClientModule = {
  globalAgent: http.Agent;
  request: ClientRequestFunction;
  get: ClientRequestFunction;
};

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
const NO_PROXY_ENV_KEYS = ["no_proxy", "NO_PROXY"] as const;
const ALL_PROXY_ENV_KEYS = [...PROXY_ENV_KEYS, ...NO_PROXY_ENV_KEYS] as const;
type ProxyEnvKey = (typeof ALL_PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

type NodeHttpAgentSnapshot = {
  httpGlobalAgent: typeof http.globalAgent;
  httpsGlobalAgent: typeof https.globalAgent;
  httpRequest: typeof http.request;
  httpGet: typeof http.get;
  httpsRequest: typeof https.request;
  httpsGet: typeof https.get;
  proxyAgent: ProxyAgent;
};

function captureProxyEnv(): ProxyEnvSnapshot {
  return {
    http_proxy: process.env["http_proxy"],
    https_proxy: process.env["https_proxy"],
    HTTP_PROXY: process.env["HTTP_PROXY"],
    HTTPS_PROXY: process.env["HTTPS_PROXY"],
    no_proxy: process.env["no_proxy"],
    NO_PROXY: process.env["NO_PROXY"],
  };
}

function injectProxyEnv(proxyUrl: string): ProxyEnvSnapshot {
  const snapshot = captureProxyEnv();
  for (const key of PROXY_ENV_KEYS) {
    process.env[key] = proxyUrl;
  }
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

function isRequestOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !(value instanceof URL);
}

function withForcedProxyAgent(args: readonly unknown[], proxyAgent: ProxyAgent): unknown[] {
  const next = [...args];
  if (next.length === 0) {
    return [{ agent: proxyAgent }];
  }

  const first = next[0];
  if (typeof first === "string" || first instanceof URL) {
    const second = next[1];
    if (typeof second === "function" || second === undefined) {
      next.splice(1, 0, { agent: proxyAgent });
      return next;
    }
    if (isRequestOptions(second)) {
      next[1] = { ...second, agent: proxyAgent };
    }
    return next;
  }

  if (isRequestOptions(first)) {
    next[0] = { ...first, agent: proxyAgent };
  }
  return next;
}

function patchClientRequest(
  module: HttpClientModule,
  original: ClientRequestFunction,
  proxyAgent: ProxyAgent,
): ClientRequestFunction {
  function patchedClientRequest(
    options: ClientRequestArg,
    callback?: ClientRequestCallback,
  ): http.ClientRequest;
  function patchedClientRequest(
    url: string | URL,
    options: http.RequestOptions,
    callback?: ClientRequestCallback,
  ): http.ClientRequest;
  function patchedClientRequest(
    optionsOrUrl: ClientRequestArg,
    ...rest: ClientRequestRestArg[]
  ): http.ClientRequest {
    const args: unknown[] = [optionsOrUrl, ...rest];
    return Reflect.apply(
      original,
      module,
      withForcedProxyAgent(args, proxyAgent),
    ) as http.ClientRequest;
  }
  return patchedClientRequest;
}

function installNodeHttpProxyAgent(): NodeHttpAgentSnapshot {
  const httpClient = http as unknown as HttpClientModule;
  const httpsClient = https as unknown as HttpClientModule;
  const snapshot: NodeHttpAgentSnapshot = {
    httpGlobalAgent: http.globalAgent,
    httpsGlobalAgent: https.globalAgent,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    proxyAgent: new ProxyAgent(),
  };
  httpClient.globalAgent = snapshot.proxyAgent;
  httpsClient.globalAgent = snapshot.proxyAgent;
  httpClient.request = patchClientRequest(httpClient, snapshot.httpRequest, snapshot.proxyAgent);
  httpClient.get = patchClientRequest(httpClient, snapshot.httpGet, snapshot.proxyAgent);
  httpsClient.request = patchClientRequest(httpsClient, snapshot.httpsRequest, snapshot.proxyAgent);
  httpsClient.get = patchClientRequest(httpsClient, snapshot.httpsGet, snapshot.proxyAgent);
  return snapshot;
}

function restoreNodeHttpProxyAgent(snapshot: NodeHttpAgentSnapshot | null): void {
  if (snapshot === null) {
    return;
  }
  const httpClient = http as unknown as HttpClientModule;
  const httpsClient = https as unknown as HttpClientModule;
  httpClient.globalAgent = snapshot.httpGlobalAgent;
  httpClient.request = snapshot.httpRequest;
  httpClient.get = snapshot.httpGet;
  httpsClient.globalAgent = snapshot.httpsGlobalAgent;
  httpsClient.request = snapshot.httpsRequest;
  httpsClient.get = snapshot.httpsGet;
  snapshot.proxyAgent.destroy();
}

function isSupportedProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
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
      "ssrf-proxy: enabled but no HTTP(S) proxy URL is configured; set ssrfProxy.proxyUrl " +
        "or OPENCLAW_SSRF_PROXY_URL to an http:// or https:// forward proxy. Using application-level SSRF guards only.",
    );
    return null;
  }

  let injectedEnvSnapshot: ProxyEnvSnapshot | null = null;
  let nodeHttpAgentSnapshot: NodeHttpAgentSnapshot | null = null;

  const restoreRuntime = (): void => {
    restoreNodeHttpProxyAgent(nodeHttpAgentSnapshot);
    nodeHttpAgentSnapshot = null;
    if (injectedEnvSnapshot !== null) {
      restoreProxyEnv(injectedEnvSnapshot);
      injectedEnvSnapshot = null;
    }
    try {
      forceResetGlobalDispatcher();
    } catch (err) {
      logWarn(`ssrf-proxy: failed to reset undici dispatcher: ${String(err)}`);
    }
  };

  try {
    injectedEnvSnapshot = injectProxyEnv(proxyUrl);
    forceResetGlobalDispatcher();
    nodeHttpAgentSnapshot = installNodeHttpProxyAgent();
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

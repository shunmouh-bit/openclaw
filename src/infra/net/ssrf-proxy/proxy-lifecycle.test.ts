import http from "node:http";
import https from "node:https";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import { startSsrFProxy, stopSsrFProxy } from "./proxy-lifecycle.js";

const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockLogWarn = vi.mocked(logWarn);
const originalHttpGlobalAgent = http.globalAgent;
const originalHttpsGlobalAgent = https.globalAgent;
const originalHttpRequest = http.request;
const originalHttpGet = http.get;
const originalHttpsRequest = https.request;
const originalHttpsGet = https.get;

describe("startSsrFProxy", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "OPENCLAW_SSRF_PROXY_URL",
  ];

  beforeEach(() => {
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockForceResetGlobalDispatcher.mockReset();
    mockLogWarn.mockReset();
    http.globalAgent = originalHttpGlobalAgent;
    https.globalAgent = originalHttpsGlobalAgent;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
  });

  afterEach(() => {
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    http.globalAgent = originalHttpGlobalAgent;
    https.globalAgent = originalHttpsGlobalAgent;
    http.request = originalHttpRequest;
    http.get = originalHttpGet;
    https.request = originalHttpsRequest;
    https.get = originalHttpsGet;
  });

  it("returns null and does not touch env when not explicitly enabled", async () => {
    const handle = await startSsrFProxy(undefined);

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(mockForceResetGlobalDispatcher).not.toHaveBeenCalled();
    expect(http.globalAgent).toBe(originalHttpGlobalAgent);
    expect(https.globalAgent).toBe(originalHttpsGlobalAgent);
  });

  it("returns null and logs when enabled without a proxy URL", async () => {
    const handle = await startSsrFProxy({ enabled: true });

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("enabled but no HTTP(S) proxy URL is configured"),
    );
  });

  it("uses OPENCLAW_SSRF_PROXY_URL when config proxyUrl is omitted", async () => {
    process.env["OPENCLAW_SSRF_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startSsrFProxy({ enabled: true });

    expect(handle?.proxyUrl).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
  });

  it("prefers config proxyUrl over OPENCLAW_SSRF_PROXY_URL", async () => {
    process.env["OPENCLAW_SSRF_PROXY_URL"] = "http://127.0.0.1:3128";

    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3129",
    });

    expect(handle?.proxyUrl).toBe("http://127.0.0.1:3129");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3129");
  });

  it("uses HTTPS proxy URLs from OPENCLAW_SSRF_PROXY_URL", async () => {
    process.env["OPENCLAW_SSRF_PROXY_URL"] = "https://127.0.0.1:3128";

    const handle = await startSsrFProxy({ enabled: true });

    expect(handle?.proxyUrl).toBe("https://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("https://127.0.0.1:3128");
  });

  it("sets standard proxy env vars", async () => {
    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).not.toBeNull();
    expect(process.env["http_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["https_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
  });

  it("clears NO_PROXY so internal destinations do not bypass the filtering proxy", async () => {
    process.env["NO_PROXY"] = "127.0.0.1,localhost,corp.example.com";
    process.env["no_proxy"] = "localhost";

    await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(process.env["no_proxy"]).toBe("");
    expect(process.env["NO_PROXY"]).toBe("");
  });

  it("activates undici and node core HTTP routing", async () => {
    await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
    expect(http.globalAgent.constructor.name).toBe("ProxyAgent");
    expect(https.globalAgent.constructor.name).toBe("ProxyAgent");
    expect(http.request).not.toBe(originalHttpRequest);
    expect(http.get).not.toBe(originalHttpGet);
    expect(https.request).not.toBe(originalHttpsRequest);
    expect(https.get).not.toBe(originalHttpsGet);
  });

  it("restores previous proxy env and node core HTTP routing on stop", async () => {
    process.env["HTTP_PROXY"] = "http://previous.example.com:8080";
    process.env["NO_PROXY"] = "corp.example.com";

    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).not.toBeNull();
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["NO_PROXY"]).toBe("");
    mockForceResetGlobalDispatcher.mockClear();

    await stopSsrFProxy(handle);

    expect(process.env["HTTP_PROXY"]).toBe("http://previous.example.com:8080");
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(http.globalAgent).toBe(originalHttpGlobalAgent);
    expect(https.globalAgent).toBe(originalHttpsGlobalAgent);
    expect(http.request).toBe(originalHttpRequest);
    expect(http.get).toBe(originalHttpGet);
    expect(https.request).toBe(originalHttpsRequest);
    expect(https.get).toBe(originalHttpsGet);
    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
  });

  it("restores env when undici activation fails", async () => {
    mockForceResetGlobalDispatcher.mockImplementationOnce(() => {
      throw new Error("dispatcher failed");
    });

    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(http.globalAgent).toBe(originalHttpGlobalAgent);
  });

  it("kill restores env synchronously during hard process exit", async () => {
    process.env["NO_PROXY"] = "corp.example.com";
    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).not.toBeNull();
    handle?.kill("SIGTERM");

    expect(process.env["HTTP_PROXY"]).toBeUndefined();
    expect(process.env["NO_PROXY"]).toBe("corp.example.com");
    expect(http.request).toBe(originalHttpRequest);
    expect(https.request).toBe(originalHttpsRequest);
  });

  it("stopSsrFProxy is a no-op when handle is null", async () => {
    await expect(stopSsrFProxy(null)).resolves.toBeUndefined();
  });
});

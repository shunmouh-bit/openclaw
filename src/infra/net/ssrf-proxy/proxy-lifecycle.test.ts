import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../undici-global-dispatcher.js", () => ({
  forceResetGlobalDispatcher: vi.fn(),
}));

vi.mock("global-agent", () => ({
  bootstrap: vi.fn(),
  createGlobalProxyAgent: vi.fn(),
}));

vi.mock("../../../logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { bootstrap as bootstrapGlobalAgent } from "global-agent";
import { logWarn } from "../../../logger.js";
import { forceResetGlobalDispatcher } from "../undici-global-dispatcher.js";
import {
  _resetGlobalAgentBootstrapForTests,
  startSsrFProxy,
  stopSsrFProxy,
} from "./proxy-lifecycle.js";

const mockForceResetGlobalDispatcher = vi.mocked(forceResetGlobalDispatcher);
const mockBootstrapGlobalAgent = vi.mocked(bootstrapGlobalAgent);
const mockLogWarn = vi.mocked(logWarn);

describe("startSsrFProxy", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeysToClean = [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "GLOBAL_AGENT_HTTP_PROXY",
    "GLOBAL_AGENT_HTTPS_PROXY",
    "GLOBAL_AGENT_FORCE_GLOBAL_AGENT",
    "GLOBAL_AGENT_NO_PROXY",
    "OPENCLAW_SSRF_PROXY_URL",
  ];

  beforeEach(() => {
    for (const key of envKeysToClean) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    mockForceResetGlobalDispatcher.mockReset();
    mockBootstrapGlobalAgent.mockReset();
    mockLogWarn.mockReset();
    _resetGlobalAgentBootstrapForTests();
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
  });

  afterEach(() => {
    for (const key of envKeysToClean) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = undefined;
  });

  it("returns null and does not touch env when not explicitly enabled", async () => {
    const handle = await startSsrFProxy(undefined);

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBeUndefined();
    expect(mockForceResetGlobalDispatcher).not.toHaveBeenCalled();
    expect(mockBootstrapGlobalAgent).not.toHaveBeenCalled();
  });

  it("returns null and logs when enabled without a proxy URL", async () => {
    const handle = await startSsrFProxy({ enabled: true });

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("enabled but no proxy URL is configured"),
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

  it("sets both undici and global-agent proxy env vars", async () => {
    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).not.toBeNull();
    expect(process.env["http_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["https_proxy"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBe("true");
  });

  it("clears NO_PROXY so internal destinations do not bypass the filtering proxy", async () => {
    process.env["NO_PROXY"] = "127.0.0.1,localhost,corp.example.com";
    process.env["no_proxy"] = "localhost";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "localhost";

    await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(process.env["no_proxy"]).toBe("");
    expect(process.env["NO_PROXY"]).toBe("");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("");
  });

  it("activates undici and global-agent routing", async () => {
    await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(mockForceResetGlobalDispatcher).toHaveBeenCalledOnce();
    expect(mockBootstrapGlobalAgent).toHaveBeenCalledOnce();
  });

  it("restores previous proxy env and global-agent state on stop", async () => {
    process.env["HTTP_PROXY"] = "http://previous.example.com:8080";
    process.env["NO_PROXY"] = "corp.example.com";
    process.env["GLOBAL_AGENT_HTTP_PROXY"] = "http://previous-global.example.com:8080";
    process.env["GLOBAL_AGENT_HTTPS_PROXY"] = "http://previous-global.example.com:8443";
    process.env["GLOBAL_AGENT_NO_PROXY"] = "global.corp.example.com";
    (global as Record<string, unknown>)["GLOBAL_AGENT"] = {
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
    };

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
    expect(process.env["GLOBAL_AGENT_HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(process.env["GLOBAL_AGENT_HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(process.env["GLOBAL_AGENT_NO_PROXY"]).toBe("global.corp.example.com");
    const agent = (global as Record<string, unknown>)["GLOBAL_AGENT"] as Record<string, unknown>;
    expect(agent["HTTP_PROXY"]).toBe("http://previous-global.example.com:8080");
    expect(agent["HTTPS_PROXY"]).toBe("http://previous-global.example.com:8443");
    expect(agent["NO_PROXY"]).toBe("global.corp.example.com");
    expect(agent["forceGlobalAgent"]).toBeUndefined();
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
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
  });

  it("restores env when global-agent bootstrap fails", async () => {
    mockBootstrapGlobalAgent.mockImplementationOnce(() => {
      throw new Error("bootstrap failed");
    });

    const handle = await startSsrFProxy({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });

    expect(handle).toBeNull();
    expect(process.env["http_proxy"]).toBeUndefined();
    expect(process.env["GLOBAL_AGENT_FORCE_GLOBAL_AGENT"]).toBeUndefined();
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
  });

  it("stopSsrFProxy is a no-op when handle is null", async () => {
    await expect(stopSsrFProxy(null)).resolves.toBeUndefined();
  });
});

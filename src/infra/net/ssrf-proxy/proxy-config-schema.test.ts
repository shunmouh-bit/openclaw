import { describe, it, expect } from "vitest";
import { SsrFProxyConfigSchema } from "./proxy-config-schema.js";

describe("SsrFProxyConfigSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(SsrFProxyConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty object", () => {
    expect(SsrFProxyConfigSchema.parse({})).toEqual({});
  });

  it("accepts a full valid config", () => {
    const result = SsrFProxyConfigSchema.parse({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
    expect(result).toMatchObject({
      enabled: true,
      proxyUrl: "http://127.0.0.1:3128",
    });
  });

  it("accepts HTTP(S) proxyUrl values using URL parser semantics", () => {
    expect(
      SsrFProxyConfigSchema.parse({
        enabled: true,
        proxyUrl: "HTTPS://proxy.example.com:8443",
      })?.proxyUrl,
    ).toBe("HTTPS://proxy.example.com:8443");
  });

  it("does not expose Caddy-specific or unsupported upstream proxy keys", () => {
    const keys = SsrFProxyConfigSchema.unwrap().keyof().options;
    expect(keys).not.toContain("binaryPath");
    expect(keys).not.toContain("extraBlockedCidrs");
    expect(keys).not.toContain("extraAllowedHosts");
    expect(keys).not.toContain("userProxy");
  });

  it("rejects proxyUrl values without an HTTP(S) scheme", () => {
    expect(() =>
      SsrFProxyConfigSchema.parse({ enabled: true, proxyUrl: "socks5://127.0.0.1" }),
    ).toThrow();
    expect(() => SsrFProxyConfigSchema.parse({ enabled: true, proxyUrl: "not-a-url" })).toThrow();
  });

  it("rejects unknown keys (strict)", () => {
    expect(() => SsrFProxyConfigSchema.parse({ unknownKey: true })).toThrow();
  });

  it("accepts enabled: false to disable the proxy", () => {
    const result = SsrFProxyConfigSchema.parse({ enabled: false });
    expect(result?.enabled).toBe(false);
  });
});

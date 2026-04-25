/**
 * SSRF network proxy module — public API surface.
 *
 * This module routes OpenClaw process HTTP traffic through an operator-managed
 * SSRF-filtering forward proxy. The proxy must enforce destination filtering
 * at connect time; OpenClaw only owns process-wide routing into that proxy.
 *
 * Integration:
 *   1. Call startSsrFProxy(config?.ssrfProxy) early in daemon/CLI startup.
 *   2. The proxy injects HTTP_PROXY / HTTPS_PROXY env vars and resets the
 *      undici global dispatcher so subsequent HTTP traffic is routed through
 *      the configured proxy.
 *   3. On shutdown, call stopSsrFProxy(handle).
 *
 * Graceful degradation:
 *   If no external proxy URL is configured, startSsrFProxy() returns null and
 *   logs a warning. Application-level fetchWithSsrFGuard protections remain
 *   active as a defence-in-depth fallback.
 */

export { startSsrFProxy, stopSsrFProxy } from "./proxy-lifecycle.js";
export type { SsrFProxyHandle } from "./proxy-lifecycle.js";

export { SsrFProxyConfigSchema } from "./proxy-config-schema.js";
export type { SsrFProxyConfig } from "./proxy-config-schema.js";

/**
 * Zod schema and TypeScript types for the user-facing `ssrfProxy` configuration key.
 */

import { z } from "zod";

function isHttpOrHttpsProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const SsrFProxyConfigSchema = z
  .object({
    /**
     * Whether to route process-wide HTTP traffic through an operator-managed
     * SSRF-filtering forward proxy.
     * Default: false (disabled).
     *
     * Set to true to enable the proxy. When disabled, OpenClaw relies on
     * application-level fetchWithSsrFGuard protections.
     */
    enabled: z.boolean().optional(),

    /**
     * HTTP(S) forward proxy URL to inject into HTTP client proxy environment variables.
     * The proxy itself is operator-managed and must enforce SSRF filtering.
     *
     * Example: "http://127.0.0.1:3128"
     */
    proxyUrl: z
      .string()
      .url()
      .refine(isHttpOrHttpsProxyUrl, {
        message: "proxyUrl must use http:// or https://",
      })
      .optional(),
  })
  .strict()
  .optional();

export type SsrFProxyConfig = z.infer<typeof SsrFProxyConfigSchema>;

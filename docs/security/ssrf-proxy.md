# SSRF Network Proxy

OpenClaw can route process-wide HTTP traffic through an operator-managed forward proxy for network-level SSRF protection. This is an optional defense-in-depth layer on top of the application-level `fetchWithSsrFGuard` DNS-pinning mechanism.

OpenClaw does not ship, download, start, or configure a proxy. You provide a filtering proxy such as Caddy, Squid, Envoy, or an equivalent egress-control service, and OpenClaw routes HTTP clients through it.

## Why Use a Filtering Proxy?

Application-level DNS pinning resolves DNS before a request and pins the checked IP. A fast DNS rebinding attack can still try to swap the destination between that check and the actual connection.

A filtering forward proxy can close that time-of-check/time-of-use window by applying destination IP rules when it resolves and dials the upstream target. This also covers raw HTTP clients inside the OpenClaw process that do not call `fetchWithSsrFGuard` directly.

## How OpenClaw Routes Traffic

When `ssrfProxy.enabled=true` and a proxy URL is configured, OpenClaw injects proxy settings for the current process:

```text
OpenClaw process
  fetch and undici       -> operator-managed filtering proxy -> public internet
  node:http and https    -> operator-managed filtering proxy -> public internet
```

OpenClaw activates two routing layers:

| Layer | Mechanism                                      | Covers                                                                 |
| ----- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| A     | undici global dispatcher via proxy environment | `fetch()` and direct `undici.request()` calls                          |
| B     | `proxy-agent` backed Node core request shim    | `node:http`, `node:https`, axios, got, node-fetch, and similar clients |

The proxy URL may use `http://` or `https://`. HTTPS destinations are supported through either proxy transport with HTTP `CONNECT`. Use `https://` for the proxy URL when the OpenClaw-to-proxy hop crosses a network boundary where proxy credentials or destination hostnames should not be visible in cleartext.

While the proxy is active, OpenClaw clears `no_proxy` and `NO_PROXY`. Those bypass lists are destination-based, so leaving `localhost` or `127.0.0.1` there would let the highest-risk SSRF targets skip the filtering proxy.

On shutdown, OpenClaw restores the previous proxy environment and resets the cached undici and Node core HTTP routing state.

## Configuration

```yaml
ssrfProxy:
  enabled: true
  proxyUrl: http://127.0.0.1:3128
```

You can also provide the URL through the environment, while keeping
`ssrfProxy.enabled=true` in config:

```bash
OPENCLAW_SSRF_PROXY_URL=http://127.0.0.1:3128 openclaw gateway run
```

`ssrfProxy.proxyUrl` takes precedence over `OPENCLAW_SSRF_PROXY_URL`.

If `enabled=true` but no proxy URL is configured, OpenClaw logs a warning and continues with application-level SSRF guards only.

## Proxy Hardening Checklist

The proxy policy is the security boundary. OpenClaw cannot verify that the proxy blocks the right targets.

Configure your proxy to:

- Bind only to loopback or a private trusted interface.
- Restrict access so only the OpenClaw process or host can use it.
- Block destination IPs after DNS resolution, at connect time.
- Block HTTP and HTTPS tunnel requests to internal destinations.
- Avoid `NO_PROXY` bypasses for loopback, private, link-local, or metadata targets.
- Avoid hostname allowlists unless you fully trust the DNS resolution path.
- Log denies and policy failures without logging request bodies, authorization headers, cookies, or other secrets.
- Keep proxy rules under version control and review changes like security policy.

## Recommended Blocked Destinations

Use this denylist as the starting point for any Caddy, Squid, Envoy, firewall, or egress proxy policy.

OpenClaw's application-level classifier lives in `src/infra/net/ssrf.ts` and `src/shared/net/ip.ts`. The relevant parity hooks are `BLOCKED_HOSTNAMES`, `BLOCKED_IPV4_SPECIAL_USE_RANGES`, `BLOCKED_IPV6_SPECIAL_USE_RANGES`, `RFC2544_BENCHMARK_PREFIX`, and the embedded IPv4 sentinel handling for NAT64, 6to4, Teredo, ISATAP, and IPv4-mapped forms. Those files are useful references when maintaining an external proxy policy, but OpenClaw does not automatically export or enforce those rules in your proxy.

| Range or host                                                                        | Why to block                                         |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `127.0.0.0/8`, `localhost`, `localhost.localdomain`                                  | IPv4 loopback                                        |
| `::1/128`                                                                            | IPv6 loopback                                        |
| `0.0.0.0/8`, `::/128`                                                                | Unspecified and this-network addresses               |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`                                      | RFC1918 private networks                             |
| `169.254.0.0/16`, `fe80::/10`                                                        | Link-local addresses and common cloud metadata paths |
| `169.254.169.254`, `metadata.google.internal`                                        | Cloud metadata services                              |
| `100.64.0.0/10`                                                                      | Carrier-grade NAT shared address space               |
| `198.18.0.0/15`, `2001:2::/48`                                                       | Benchmarking ranges                                  |
| `192.0.0.0/24`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32` | Special-use and documentation ranges                 |
| `224.0.0.0/4`, `ff00::/8`                                                            | Multicast                                            |
| `240.0.0.0/4`                                                                        | Reserved IPv4                                        |
| `fc00::/7`, `fec0::/10`                                                              | IPv6 local/private ranges                            |
| `100::/64`, `2001:20::/28`                                                           | IPv6 discard and ORCHIDv2 ranges                     |
| `64:ff9b::/96`, `64:ff9b:1::/48`                                                     | NAT64 prefixes with embedded IPv4                    |
| `2002::/16`, `2001::/32`                                                             | 6to4 and Teredo with embedded IPv4                   |
| `::/96`, `::ffff:0:0/96`                                                             | IPv4-compatible and IPv4-mapped IPv6                 |

If your provider documents additional metadata hostnames or service ranges, add those too.

## Caddy Example

Caddy requires the `github.com/caddyserver/forwardproxy` plugin for forward proxy support. The exact syntax depends on that plugin version, but the important properties are:

- Listen on loopback.
- Disable Caddy's admin API unless you need it.
- Use deny ACLs for the blocked destinations above.
- End with an allow-all rule for public internet destinations.
- Do not configure upstream proxy mode unless you have verified it preserves ACL enforcement.

Example JSON shape:

```json
{
  "admin": { "disabled": true },
  "apps": {
    "http": {
      "servers": {
        "openclaw-ssrf-proxy": {
          "listen": ["127.0.0.1:3128"],
          "routes": [
            {
              "handle": [
                {
                  "handler": "forward_proxy",
                  "hide_ip": true,
                  "hide_via": true,
                  "acl": [
                    {
                      "subjects": [
                        "localhost",
                        "localhost.localdomain",
                        "metadata.google.internal",
                        "127.0.0.0/8",
                        "0.0.0.0/8",
                        "10.0.0.0/8",
                        "172.16.0.0/12",
                        "192.168.0.0/16",
                        "169.254.0.0/16",
                        "169.254.169.254",
                        "100.64.0.0/10",
                        "198.18.0.0/15",
                        "192.0.0.0/24",
                        "192.0.2.0/24",
                        "198.51.100.0/24",
                        "203.0.113.0/24",
                        "224.0.0.0/4",
                        "240.0.0.0/4",
                        "::1/128",
                        "::/128",
                        "fe80::/10",
                        "fc00::/7",
                        "fec0::/10",
                        "ff00::/8",
                        "100::/64",
                        "2001:2::/48",
                        "2001:20::/28",
                        "2001:db8::/32",
                        "64:ff9b::/96",
                        "64:ff9b:1::/48",
                        "2002::/16",
                        "2001::/32",
                        "::/96",
                        "::ffff:0:0/96"
                      ],
                      "allow": false
                    },
                    { "subjects": ["all"], "allow": true }
                  ]
                }
              ]
            }
          ]
        }
      }
    }
  }
}
```

Keep the example's deny subjects aligned with the full recommended denylist above.

## Squid Example

Squid can act as a local forward proxy. Start from a deny-by-destination policy and bind it to loopback:

```squidconf
http_port 127.0.0.1:3128

acl openclaw_src src 127.0.0.1/32

acl blocked_dst dst 127.0.0.0/8
acl blocked_dst dst 0.0.0.0/8
acl blocked_dst dst 10.0.0.0/8
acl blocked_dst dst 172.16.0.0/12
acl blocked_dst dst 192.168.0.0/16
acl blocked_dst dst 169.254.0.0/16
acl blocked_dst dst 100.64.0.0/10
acl blocked_dst dst 198.18.0.0/15
acl blocked_dst dst 224.0.0.0/4
acl blocked_dst dst 240.0.0.0/4
acl blocked_hosts dstdomain localhost localhost.localdomain metadata.google.internal

http_access deny blocked_hosts
http_access deny blocked_dst
http_access allow openclaw_src
http_access deny all
```

Add equivalent IPv6 rules for your Squid version and deployment mode. Validate both plain HTTP requests and HTTPS `CONNECT` requests to blocked destinations.

## Envoy Note

Envoy can enforce this pattern, but the config is usually longer because it is normally expressed through listener filters, RBAC rules, dynamic forward proxy, and cluster policy. If you use Envoy, the acceptance test is more important than the specific config shape:

- Requests to public internet destinations succeed.
- Requests and `CONNECT` tunnels to every blocked CIDR fail.
- DNS rebinding attempts are evaluated at the proxy's connect-time resolution point.
- OpenClaw is the only workload allowed to use the listener.

## Validation

After configuring a proxy, test from the same host and user that runs OpenClaw:

```bash
curl -x http://127.0.0.1:3128 https://example.com/
curl -x http://127.0.0.1:3128 http://127.0.0.1/
curl -x http://127.0.0.1:3128 http://169.254.169.254/
```

The public request should succeed. The loopback and metadata requests should fail at the proxy.

Then enable proxy routing and start OpenClaw with the proxy URL:

```bash
openclaw config set ssrfProxy.enabled true
OPENCLAW_SSRF_PROXY_URL=http://127.0.0.1:3128 openclaw gateway run
```

or set:

```yaml
ssrfProxy:
  enabled: true
  proxyUrl: http://127.0.0.1:3128
```

## Security Notes

- This feature improves coverage for raw process-local HTTP clients, but it does not replace application-level `fetchWithSsrFGuard`.
- Child processes and native addons may not honor Node-level proxy routing unless they inherit and respect proxy environment variables.
- For a hard egress guarantee, pair this with host, container, VM, or network policy that prevents OpenClaw from reaching the public internet except through the filtering proxy.
- OpenClaw does not inspect, test, or certify your proxy policy.
- Treat changes to proxy ACLs as security-sensitive configuration changes.

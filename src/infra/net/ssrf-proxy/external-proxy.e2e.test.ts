import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

async function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server | null): Promise<void> {
  if (server === null || !server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function createTunnelProxy(seenConnectTargets: string[]): Server {
  const proxy = createServer((req, res) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("absolute-form proxy URL required");
      return;
    }

    const upstream = httpRequest(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: req.method,
        headers: { ...req.headers, host: targetUrl.host, connection: "close" },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on("error", () => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("upstream error");
    });
    req.pipe(upstream);
  });

  proxy.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    seenConnectTargets.push(target);

    let targetUrl: URL;
    try {
      targetUrl = new URL(`http://${target}`);
    } catch {
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(Number(targetUrl.port), targetUrl.hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
  });

  return proxy;
}

async function runNodeModule(
  source: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child process timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("SSRF external proxy routing", () => {
  let target: Server | null = null;
  let proxy: Server | null = null;

  afterEach(async () => {
    await closeServer(proxy);
    await closeServer(target);
    proxy = null;
    target = null;
  });

  it("routes fetch and node:http through an operator-managed proxy even when NO_PROXY includes loopback", async () => {
    target = createServer((_req, res) => {
      res.writeHead(218, { "content-type": "text/plain" });
      res.end("from loopback target");
    });
    const targetPort = await listenOnLoopback(target);

    const seenConnectTargets: string[] = [];
    proxy = createTunnelProxy(seenConnectTargets);
    const proxyPort = await listenOnLoopback(proxy);

    const child = await runNodeModule(
      `
        import http from "node:http";
        import { fetch as undiciFetch } from "undici";
        import { startSsrFProxy, stopSsrFProxy } from "./src/infra/net/ssrf-proxy/proxy-lifecycle.ts";

        async function nodeHttpGet(url) {
          return new Promise((resolve, reject) => {
            const req = http.get(url, (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => {
                resolve({ status: response.statusCode, body });
              });
            });
            req.setTimeout(5000, () => {
              req.destroy(new Error("node:http request timed out"));
            });
            req.on("error", reject);
          });
        }

        const handle = await startSsrFProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external SSRF proxy routing to start");
        }
        try {
          const response = await undiciFetch(process.env.OPENCLAW_TEST_TARGET_URL, {
            signal: AbortSignal.timeout(5000),
          });
          const body = await response.text();
          const nodeHttp = await nodeHttpGet(process.env.OPENCLAW_TEST_NODE_HTTP_TARGET_URL);
          console.log(JSON.stringify({ fetch: { status: response.status, body }, nodeHttp }));
        } finally {
          await stopSsrFProxy(handle);
        }
      `,
      {
        ...process.env,
        OPENCLAW_SSRF_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        OPENCLAW_TEST_TARGET_URL: `http://127.0.0.1:${targetPort}/private-metadata`,
        OPENCLAW_TEST_NODE_HTTP_TARGET_URL: `http://127.0.0.1:${targetPort}/node-http-metadata`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "localhost",
        GLOBAL_AGENT_NO_PROXY: "localhost",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"fetch":{"status":218');
    expect(child.stdout).toContain('"nodeHttp":{"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toContain(`127.0.0.1:${targetPort}`);
    expect(seenConnectTargets).toContain(`http://127.0.0.1:${targetPort}/node-http-metadata`);
  });
});

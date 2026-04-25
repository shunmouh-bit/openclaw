import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
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
  const proxy = createServer((_req, res) => {
    res.writeHead(501, { "content-type": "text/plain" });
    res.end("CONNECT required");
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

  it("routes fetch through an operator-managed proxy even when NO_PROXY includes loopback", async () => {
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
        import { fetch as undiciFetch } from "undici";
        import { startSsrFProxy, stopSsrFProxy } from "./src/infra/net/ssrf-proxy/proxy-lifecycle.ts";

        const handle = await startSsrFProxy({ enabled: true });
        if (handle === null) {
          throw new Error("expected external SSRF proxy routing to start");
        }
        try {
          const response = await undiciFetch(process.env.OPENCLAW_TEST_TARGET_URL, {
            signal: AbortSignal.timeout(5000),
          });
          const body = await response.text();
          console.log(JSON.stringify({ status: response.status, body }));
        } finally {
          await stopSsrFProxy(handle);
        }
      `,
      {
        ...process.env,
        OPENCLAW_SSRF_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        OPENCLAW_TEST_TARGET_URL: `http://127.0.0.1:${targetPort}/private-metadata`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "localhost",
        GLOBAL_AGENT_NO_PROXY: "localhost",
      },
    );

    expect(child.stderr).toBe("");
    expect(child.code).toBe(0);
    expect(child.stdout).toContain('"status":218');
    expect(child.stdout).toContain('"body":"from loopback target"');
    expect(seenConnectTargets).toContain(`127.0.0.1:${targetPort}`);
  });
});

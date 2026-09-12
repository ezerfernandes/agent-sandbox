import { describe, expect, it, afterEach } from "vitest";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { openVsockPort } from "./transport.js";

// Deliberately in its own file: transport.test.ts mocks the whole `net` module,
// and these cases need a real unix socket to exercise the CONNECT handshake.

const servers: net.Server[] = [];
const sockPaths: string[] = [];

function tmpSockPath(): string {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vsock-test-")),
    "v.sock",
  );
  sockPaths.push(p);
  return p;
}

/** Stand-in for the Firecracker vsock UDS: replies to `CONNECT <port>` and echoes. */
function startFakeVsock(
  sockPath: string,
  onConnect: (socket: net.Socket, port: string) => void,
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      socket.removeListener("data", onData);
      onConnect(socket, line.replace("CONNECT ", ""));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(sockPath, () => resolve(server)));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  for (const p of sockPaths.splice(0)) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe("openVsockPort", () => {
  it("performs the CONNECT handshake and returns bytes received after the OK line", async () => {
    const sockPath = tmpSockPath();
    let requestedPort = "";
    await startFakeVsock(sockPath, (socket, port) => {
      requestedPort = port;
      socket.write("OK 5900\nRFB 003.008\n");
    });

    const { socket, rest } = await openVsockPort(sockPath, 5900);

    expect(requestedPort).toBe("5900");
    expect(rest.toString()).toBe("RFB 003.008\n");
    socket.destroy();
  });

  it("returns an empty rest buffer when the OK line arrives alone", async () => {
    const sockPath = tmpSockPath();
    await startFakeVsock(sockPath, (socket) => socket.write("OK 5900\n"));

    const { socket, rest } = await openVsockPort(sockPath, 5900);

    expect(rest.length).toBe(0);
    socket.destroy();
  });

  it("keeps piping data that arrives after the handshake", async () => {
    const sockPath = tmpSockPath();
    await startFakeVsock(sockPath, (socket) => {
      socket.write("OK 5900\n");
      socket.on("data", (chunk) => socket.write(chunk));
    });

    const { socket } = await openVsockPort(sockPath, 5900);
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.once("data", resolve);
      socket.write("ping");
    });

    expect(echoed.toString()).toBe("ping");
    socket.destroy();
  });

  it("rejects and destroys the socket when the guest does not answer OK", async () => {
    const sockPath = tmpSockPath();
    let guestClosed: Promise<void> | undefined;
    await startFakeVsock(sockPath, (socket) => {
      guestClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write("ERR connection refused\n");
    });

    await expect(openVsockPort(sockPath, 5900)).rejects.toThrow(
      /vsock port 5900 refused/i,
    );
    // The rejected socket is destroyed, so the guest side sees the hang-up.
    await expect(guestClosed).resolves.toBeUndefined();
  });

  it("rejects when the connection closes before the OK line", async () => {
    const sockPath = tmpSockPath();
    await startFakeVsock(sockPath, (socket) => socket.end());

    await expect(openVsockPort(sockPath, 5900)).rejects.toThrow(
      /closed before/i,
    );
  });

  it("rejects when the guest never answers within the handshake timeout", async () => {
    const sockPath = tmpSockPath();
    await startFakeVsock(sockPath, () => {
      /* accept the CONNECT and stay silent */
    });

    await expect(openVsockPort(sockPath, 5900, 200)).rejects.toThrow(/timeout/i);
  });

  it("leaves an error listener attached so a later socket error cannot crash the process", async () => {
    const sockPath = tmpSockPath();
    await startFakeVsock(sockPath, (socket) => socket.write("OK 5900\n"));

    const { socket } = await openVsockPort(sockPath, 5900);

    expect(socket.listenerCount("error")).toBeGreaterThan(0);
    socket.emit("error", new Error("boom"));
    socket.destroy();
  });
});

import net, { Socket } from "net";
import { vmLogger } from "../logger.js";
import { vsockConnectionTime, vsockErrors } from "../metrics.js";
import type { Vm } from "./vm-manager.js";

export async function connectVsock(
  path: string,
  timeout = 5000,
): Promise<Socket> {
  vmLogger.debug({ path, timeoutMs: timeout }, "connecting to vsock");
  const start = performance.now();

  return new Promise((resolve, reject) => {
    const connectStart = Date.now();

    const tryConnect = () => {
      const socket = net.createConnection({ path });

      socket.once("connect", () => {
        const durationSec = (performance.now() - start) / 1000;
        vsockConnectionTime.observe(durationSec);
        vmLogger.debug(
          { path, elapsedMs: Date.now() - connectStart },
          "vsock connected",
        );
        resolve(socket);
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - connectStart > timeout) {
          vsockErrors.inc({ error_type: "timeout" });
          vmLogger.error({ path, timeoutMs: timeout }, "vsock connection timeout");
          return reject(new Error("Vsock timeout"));
        }

        setTimeout(tryConnect, 100);
      });
    };

    tryConnect();
  });
}

export interface VsockPortConnection {
  socket: Socket;
  /** Bytes that arrived after the `OK <port>` line — already part of the guest stream. */
  rest: Buffer;
}

/**
 * Open a raw stream to an arbitrary port inside the guest (VNC on 5900, for
 * one) over the Firecracker vsock multiplexer.
 *
 * The multiplexer answers `CONNECT <port>` with an `OK <hostPort>` line before
 * handing over the byte stream, and the guest's own first bytes (the RFB
 * greeting) can share that same TCP segment — hence `rest`, which the caller
 * must forward before piping the socket.
 */
export async function openVsockPort(
  vsockPath: string,
  port: number,
  timeoutMs = 5000,
): Promise<VsockPortConnection> {
  const socket = await connectVsock(vsockPath, timeoutMs);
  socket.setNoDelay(true);

  return new Promise<VsockPortConnection>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("end", onEnd);
      socket.removeListener("close", onEnd);
      fn();
    };

    const fail = (err: Error, errorType: string) => {
      finish(() => {
        vsockErrors.inc({ error_type: errorType });
        socket.destroy();
        reject(err);
      });
    };

    const timer = setTimeout(() => {
      vmLogger.error(
        { vsockPath, port, timeoutMs },
        "vsock port handshake timeout",
      );
      fail(new Error(`Vsock port ${port} handshake timeout`), "timeout");
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      const index = buffer.indexOf(0x0a); // "\n"
      if (index < 0) {
        if (buffer.length > 4096) {
          fail(
            new Error(`Vsock port ${port} refused: handshake line too long`),
            "parse_error",
          );
        }
        return;
      }

      const line = buffer.subarray(0, index).toString("utf8").trim();
      const rest = buffer.subarray(index + 1);

      if (!line.startsWith("OK")) {
        vmLogger.error({ vsockPath, port, line }, "vsock port handshake rejected");
        fail(new Error(`Vsock port ${port} refused: ${line}`), "connection_error");
        return;
      }

      finish(() => {
        vmLogger.debug({ vsockPath, port, line }, "vsock port connected");
        // Permanent listener: an unhandled 'error' on a raw socket becomes an
        // uncaughtException, which server.ts turns into process.exit(1).
        socket.on("error", (err) => {
          vsockErrors.inc({ error_type: "connection_error" });
          vmLogger.warn({ vsockPath, port, err }, "vsock port socket error");
        });
        resolve({ socket, rest });
      });
    };

    const onError = (err: Error) => {
      fail(err, "connection_error");
    };

    const onEnd = () => {
      fail(
        new Error(`Vsock port ${port} closed before handshake completed`),
        "connection_closed",
      );
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onEnd);

    socket.write(`CONNECT ${port}\n`);
  });
}

export async function getVmSocket(vm: Vm): Promise<Socket> {
  if (vm.socket && !vm.socket.destroyed) {
    return vm.socket;
  }

  if (vm.connectingSocket) {
    return vm.connectingSocket;
  }

  vm.connectingSocket = (async () => {
    try {
      vmLogger.debug({ vmId: vm.id, vsock: vm.vsock }, "establishing new VM socket");
      const socket = await connectVsock(vm.vsock);
      socket.write("CONNECT 5000\n");
      vm.socket = socket;
      return socket;
    } finally {
      vm.connectingSocket = undefined;
    }
  })();

  return vm.connectingSocket;
}

/**
 * Simple async mutex to serialize requests on a single vsock connection.
 * Prevents concurrent callers from interleaving responses.
 */
const vmLocks = new Map<string, Promise<void>>();

export async function acquireVmLock(vmId: string): Promise<() => void> {
  // Wait for any existing lock to release
  while (vmLocks.has(vmId)) {
    await vmLocks.get(vmId);
  }

  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = () => {
      vmLocks.delete(vmId);
      resolve();
    };
  });

  vmLocks.set(vmId, lockPromise);
  return release!;
}


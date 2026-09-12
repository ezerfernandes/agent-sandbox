
/** Options for creating a Sandbox client. */
export interface SandboxClientOptions {
  /** Base URL (default: "http://localhost:3000"). */
  baseUrl?: string;

  /** API Key for authentication (e.g. "sk_test_..."). */
  apiKey?: string;

  /** Default template (default: "node"). */
  defaultTemplate?: string;

  /** Default timeout in milliseconds (default: 30_000). */
  defaultTimeout?: number;

  /** Extra headers to include with every request (e.g. Authorization). */
  headers?: Record<string, string>;
}

/** Options for executing a command inside a session. */
export interface ExecOptions {
  /** Command arguments. */
  args?: string[];

  /** Working directory relative to /workspace. */
  cwd?: string;

  /** Additional environment variables. */
  env?: Record<string, string>;

  /** Timeout in milliseconds for this execution (overrides client default). */
  timeout?: number;

  /**
   * Caller-chosen id (8-64 of `[A-Za-z0-9_-]`) for this execution, so it can be
   * stopped later with {@link Session.cancel}. Generated server-side if omitted.
   */
  messageId?: string;
}

/** A single output chunk from command execution. */
export interface OutputChunk {
  stream: "stdout" | "stderr";
  data: string;
  ts: number;
}

/** Result of a command execution. */
export interface ExecResult {
  exitCode: number;
  signal?: string;
  duration: number;
  /** Id of this execution; pass it to {@link Session.cancel} to stop it. */
  messageId?: string;
  output: OutputChunk[];
}

/** A streaming chunk emitted during NDJSON execution. */
export interface StreamChunk {
  type: "started" | "stream" | "result" | "error";
  /** Present on the leading `started` frame: the id to cancel this execution with. */
  messageId?: string;
  stream?: "stdout" | "stderr";
  data?: string;
  exitCode?: number;
  signal?: string;
  duration?: number;
  error?: string;
  ts?: number;
}

/** Result of writing a file. */
export interface WriteResult {
  bytesWritten: number;
}

/** Result of reading a file. */
export interface ReadResult {
  /** utf8 text, or the raw base64 payload when `encoding: "base64"` was requested. */
  content: string;
  size: number;
  encoding?: "utf8" | "base64";
}

/** A file or directory entry. */
export interface FileEntry {
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Result of listing files. */
export interface ListFilesResult {
  files: FileEntry[];
}

/** Information about a registered template. */
export interface Template {
  name: string;
  displayName: string;
  tools: string[];
}

/** Session info */
export interface SessionInfo {
  id: string;
  state: string;
  createdAt: number;
  lastActivity: number;
  templateName?: string;
}

/** Error thrown by the SDK*/
export class SandboxError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

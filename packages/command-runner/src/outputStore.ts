// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { StreamingRedactor } from "./redactor.ts";

const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const DEFAULT_MAX_OUTPUT_BYTES_PER_STREAM = 1_048_576;
export const MAX_OUTPUT_PAGE_BYTES = 65_536;
const MIN_OUTPUT_PAGE_BYTES = 4;

const completeUtf8ByteLength = (buffer: Buffer): number => {
  if (buffer.length === 0) return 0;
  let leadingIndex = buffer.length - 1;
  while (leadingIndex > 0 && (buffer[leadingIndex]! & 0xc0) === 0x80) leadingIndex -= 1;
  const leadingByte = buffer[leadingIndex]!;
  const expectedLength =
    (leadingByte & 0x80) === 0
      ? 1
      : (leadingByte & 0xe0) === 0xc0
        ? 2
        : (leadingByte & 0xf0) === 0xe0
          ? 3
          : (leadingByte & 0xf8) === 0xf0
            ? 4
            : 1;
  return buffer.length - leadingIndex < expectedLength ? leadingIndex : buffer.length;
};

export interface OutputArtifact {
  readonly locationReference: string;
  readonly digest: string;
  readonly observedBytes: number;
  readonly persistedBytes: number;
  readonly truncated: boolean;
}

interface StreamCapture {
  readonly write: (chunk: Uint8Array) => void;
  readonly close: () => Promise<OutputArtifact>;
}

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Command output directory must be a real directory.");
  }
  await NodeFSP.chmod(path, 0o700);
};

const openPrivateOutput = async (path: string): Promise<NodeFSP.FileHandle> =>
  NodeFSP.open(
    path,
    NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      NodeFS.constants.O_WRONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    0o600,
  );

export class CommandOutputStore {
  readonly stateRoot: string;
  readonly outputRoot: string;
  readonly #maximumBytesPerStream: number;

  constructor(input: { readonly stateRoot: string; readonly maximumBytesPerStream?: number }) {
    this.stateRoot = NodePath.resolve(input.stateRoot);
    this.outputRoot = NodePath.join(this.stateRoot, "command-output");
    this.#maximumBytesPerStream =
      input.maximumBytesPerStream ?? DEFAULT_MAX_OUTPUT_BYTES_PER_STREAM;
    if (!Number.isSafeInteger(this.#maximumBytesPerStream) || this.#maximumBytesPerStream < 1) {
      throw new TypeError("Maximum output bytes must be a positive safe integer.");
    }
  }

  referencesFor(executionId: string): {
    readonly stdout: string;
    readonly stderr: string;
  } {
    if (!SAFE_EXECUTION_ID.test(executionId)) {
      throw new TypeError("Process-host execution ID is unsafe for artifact storage.");
    }
    return {
      stdout: `command-output/${executionId}/stdout.log`,
      stderr: `command-output/${executionId}/stderr.log`,
    };
  }

  async createCapture(
    executionId: string,
    redactionValues: ReadonlyArray<string>,
  ): Promise<{
    readonly stdout: StreamCapture;
    readonly stderr: StreamCapture;
  }> {
    if (!SAFE_EXECUTION_ID.test(executionId)) {
      throw new TypeError("Process-host execution ID is unsafe for artifact storage.");
    }
    await ensurePrivateDirectory(this.stateRoot);
    await ensurePrivateDirectory(this.outputRoot);
    const executionDirectory = NodePath.join(this.outputRoot, executionId);
    await ensurePrivateDirectory(executionDirectory);
    return {
      stdout: await this.#createStream(
        NodePath.join(executionDirectory, "stdout.log"),
        redactionValues,
      ),
      stderr: await this.#createStream(
        NodePath.join(executionDirectory, "stderr.log"),
        redactionValues,
      ),
    };
  }

  async readPage(input: {
    readonly locationReference: string;
    readonly cursor?: number;
    readonly limit?: number;
  }): Promise<{
    readonly data: string;
    readonly nextCursor: number;
    readonly end: boolean;
  }> {
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? MAX_OUTPUT_PAGE_BYTES;
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new TypeError("Output cursor is invalid.");
    if (
      !Number.isSafeInteger(limit) ||
      limit < MIN_OUTPUT_PAGE_BYTES ||
      limit > MAX_OUTPUT_PAGE_BYTES
    ) {
      throw new TypeError("Output page limit is invalid.");
    }
    const normalizedReference = input.locationReference.replaceAll("\\", "/");
    const [directory, executionId, filename, ...extra] = normalizedReference.split("/");
    if (
      directory !== "command-output" ||
      !executionId ||
      !SAFE_EXECUTION_ID.test(executionId) ||
      (filename !== "stdout.log" && filename !== "stderr.log") ||
      extra.length > 0
    ) {
      throw new TypeError(
        "Output artifact reference is not a generated command output or escapes factory state.",
      );
    }
    const executionDirectory = NodePath.join(this.outputRoot, executionId);
    const outputRootStat = await NodeFSP.lstat(this.outputRoot);
    const executionDirectoryStat = await NodeFSP.lstat(executionDirectory);
    if (
      !outputRootStat.isDirectory() ||
      outputRootStat.isSymbolicLink() ||
      !executionDirectoryStat.isDirectory() ||
      executionDirectoryStat.isSymbolicLink()
    ) {
      throw new TypeError("Output artifact directory is unsafe.");
    }
    const absolute = NodePath.join(executionDirectory, filename);
    const handle = await NodeFSP.open(
      absolute,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new TypeError("Output artifact is not a regular file.");
      if (cursor > 0 && cursor < stat.size) {
        const boundary = Buffer.alloc(1);
        await handle.read(boundary, 0, 1, cursor);
        if ((boundary[0]! & 0xc0) === 0x80) {
          throw new TypeError("Output cursor does not reference a UTF-8 boundary.");
        }
      }
      const length = Math.min(limit, Math.max(0, stat.size - cursor));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor);
      const safeLength = completeUtf8ByteLength(buffer.subarray(0, bytesRead));
      return {
        data: buffer.subarray(0, safeLength).toString("utf8"),
        nextCursor: cursor + safeLength,
        end: cursor + safeLength >= stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async #createStream(
    path: string,
    redactionValues: ReadonlyArray<string>,
  ): Promise<StreamCapture> {
    const handle = await openPrivateOutput(path);
    const redactor = new StreamingRedactor(redactionValues);
    const digest = NodeCrypto.createHash("sha256");
    let observedBytes = 0;
    let persistedBytes = 0;
    let truncated = false;
    let queue = Promise.resolve();
    let writeError: unknown;
    let closed = false;
    let result: OutputArtifact | undefined;
    let closeFailure: { readonly cause: unknown } | undefined;
    const persist = (text: string): void => {
      if (text.length === 0) return;
      const buffer = Buffer.from(text, "utf8");
      const remaining = this.#maximumBytesPerStream - persistedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const output = buffer.subarray(0, remaining);
      if (output.length < buffer.length) truncated = true;
      persistedBytes += output.length;
      digest.update(output);
      queue = queue.then(async () => {
        if (writeError !== undefined) return;
        try {
          await handle.write(output);
        } catch (cause) {
          writeError = cause;
        }
      });
    };
    return {
      write: (chunk) => {
        if (closed) return;
        observedBytes += chunk.byteLength;
        persist(redactor.push(chunk));
      },
      close: async () => {
        if (result) return result;
        if (closeFailure) throw closeFailure.cause;
        if (!closed) {
          closed = true;
          persist(redactor.finish());
          let failure: { readonly cause: unknown } | undefined;
          try {
            await queue;
            if (writeError !== undefined) throw writeError;
            await handle.chmod(0o600);
            await handle.sync();
          } catch (cause) {
            failure = { cause };
          }
          try {
            await handle.close();
          } catch (cause) {
            failure ??= { cause };
          }
          if (failure) {
            closeFailure = failure;
            throw failure.cause;
          }
        }
        result = {
          locationReference: NodePath.relative(this.stateRoot, path).replaceAll("\\", "/"),
          digest: digest.digest("hex"),
          observedBytes,
          persistedBytes,
          truncated,
        };
        return result;
      },
    };
  }
}

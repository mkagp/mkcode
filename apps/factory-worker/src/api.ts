// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import {
  ApprovalResolveRequest,
  FactoryApiVersion,
  WorkflowListDefaultPageSize,
  WorkflowListMaximumPageSize,
  WorkflowCancelRequest,
  WorkflowCreateRequest,
  type FactoryApiError,
} from "@mkcode/factory-contracts";
import {
  isWorkflowEngineError,
  type WorkflowEngine,
  WorkflowEngineError,
} from "@mkcode/workflow-engine";
import * as Schema from "effect/Schema";

const MAX_BODY_BYTES = 1_048_576;
const decodeCreate = Schema.decodeUnknownSync(WorkflowCreateRequest, {
  onExcessProperty: "error",
  errors: "all",
});
const decodeCancel = Schema.decodeUnknownSync(WorkflowCancelRequest, {
  onExcessProperty: "error",
  errors: "all",
});
const decodeApproval = Schema.decodeUnknownSync(ApprovalResolveRequest, {
  onExcessProperty: "error",
  errors: "all",
});

const decodeRequest = <A>(decode: (input: unknown) => A, input: unknown): A => {
  try {
    return decode(input);
  } catch {
    throw new WorkflowEngineError(
      "invalid_request",
      "Request body does not match the factory API contract.",
    );
  }
};

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
};

const readJsonBody = async (request: NodeHttp.IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new WorkflowEngineError("invalid_request", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkflowEngineError("invalid_request", "Request body must be valid JSON.");
  }
};

const equalCredential = (left: string, right: string): boolean => {
  const leftDigest = NodeCrypto.createHash("sha256").update(left).digest();
  const rightDigest = NodeCrypto.createHash("sha256").update(right).digest();
  return NodeCrypto.timingSafeEqual(leftDigest, rightDigest);
};

const bearerCredential = (request: NodeHttp.IncomingMessage): string | undefined => {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const credential = authorization.slice("Bearer ".length).trim();
  return credential.length > 0 ? credential : undefined;
};

const statusForError = (code: FactoryApiError["code"]): number => {
  switch (code) {
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
    case "stale_version":
    case "invalid_transition":
      return 409;
    case "invalid_request":
    case "invalid_cursor":
      return 400;
    case "unsupported_schema":
      return 503;
    case "internal_error":
      return 500;
  }
};

const safeError = (cause: unknown): FactoryApiError => {
  if (isWorkflowEngineError(cause)) {
    return {
      code: cause.code,
      message: cause.message,
      ...(cause.details ? { details: cause.details } : {}),
    };
  }
  return {
    code: "internal_error",
    message: "The factory worker could not complete the request.",
  };
};

const decodeIdentifier = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WorkflowEngineError("invalid_request", "Route identifier is malformed.");
  }
};

const workflowListPagination = (url: URL): { readonly cursor: number; readonly limit: number } => {
  const cursorText = url.searchParams.get("cursor");
  const limitText = url.searchParams.get("limit");
  const cursor = cursorText === null ? 0 : Number(cursorText);
  const requestedLimit = limitText === null ? WorkflowListDefaultPageSize : Number(limitText);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new WorkflowEngineError("invalid_cursor", "Workflow-list cursor is invalid.");
  }
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new WorkflowEngineError("invalid_request", "Workflow-list page limit is invalid.");
  }
  return {
    cursor,
    limit: Math.min(requestedLimit, WorkflowListMaximumPageSize),
  };
};

export function createFactoryApiServer(input: {
  readonly engine: WorkflowEngine;
  readonly credential: string;
  readonly workerInstanceId: string;
}): NodeHttp.Server {
  return NodeHttp.createServer((request, response) => {
    void (async () => {
      const credential = bearerCredential(request);
      if (!credential || !equalCredential(credential, input.credential)) {
        json(response, 401, {
          code: "unauthorized",
          message: "A valid factory service credential is required.",
        } satisfies FactoryApiError);
        return;
      }

      const url = new URL(request.url ?? "/", "http://factory-worker.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          ok: true,
          apiVersion: FactoryApiVersion,
          workerInstanceId: input.workerInstanceId,
          schemaVersion: input.engine.schemaVersion,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v1/workflows") {
        const body = decodeRequest(decodeCreate, await readJsonBody(request));
        json(response, 201, input.engine.createWorkflow(body));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/workflows") {
        json(response, 200, input.engine.listWorkflowPage(workflowListPagination(url)));
        return;
      }

      const workflowMatch = /^\/v1\/workflows\/([^/]+)$/u.exec(url.pathname);
      if (method === "GET" && workflowMatch?.[1]) {
        json(response, 200, input.engine.readWorkflow(decodeIdentifier(workflowMatch[1])));
        return;
      }

      const cancelMatch = /^\/v1\/workflows\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (method === "POST" && cancelMatch?.[1]) {
        const body = decodeRequest(decodeCancel, await readJsonBody(request));
        json(response, 200, input.engine.cancelWorkflow(decodeIdentifier(cancelMatch[1]), body));
        return;
      }

      const approvalMatch = /^\/v1\/approvals\/([^/]+)\/resolve$/u.exec(url.pathname);
      if (method === "POST" && approvalMatch?.[1]) {
        const body = decodeRequest(decodeApproval, await readJsonBody(request));
        json(response, 200, input.engine.resolveApproval(decodeIdentifier(approvalMatch[1]), body));
        return;
      }

      if (method === "GET" && url.pathname === "/v1/events") {
        const afterText = url.searchParams.get("after");
        const limitText = url.searchParams.get("limit");
        const workflowRunId = url.searchParams.get("runId");
        json(
          response,
          200,
          input.engine.listEvents({
            ...(afterText === null ? {} : { afterCursor: Number(afterText) }),
            ...(limitText === null ? {} : { limit: Number(limitText) }),
            ...(workflowRunId ? { workflowRunId } : {}),
          }),
        );
        return;
      }

      json(response, 404, {
        code: "not_found",
        message: "Factory API route was not found.",
      } satisfies FactoryApiError);
    })().catch((cause: unknown) => {
      const error = safeError(cause);
      json(response, statusForError(error.code), error);
    });
  });
}

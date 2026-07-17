// @effect-diagnostics globalTimers:off -- This transport owns a bounded HTTP request deadline.
import {
  ApprovalResolveRequest,
  CommandOutputPage,
  CommandRun,
  EventsListResult,
  FactoryApiError,
  FactoryHealth,
  WorkflowCancelRequest,
  WorkflowCreateRequest,
  WorkflowCreateResult,
  WorkflowDetail,
  WorkflowListResult,
  Workspace,
  WorkspaceActionRequest,
  type ApprovalResolveRequest as ApprovalResolveRequestType,
  type CommandOutputPage as CommandOutputPageType,
  type CommandRun as CommandRunType,
  type EventsListResult as EventsListResultType,
  type FactoryHealth as FactoryHealthType,
  type WorkflowCancelRequest as WorkflowCancelRequestType,
  type WorkflowCreateRequest as WorkflowCreateRequestType,
  type WorkflowCreateResult as WorkflowCreateResultType,
  type WorkflowDetail as WorkflowDetailType,
  type WorkflowListResult as WorkflowListResultType,
  type Workspace as WorkspaceType,
  type WorkspaceActionRequest as WorkspaceActionRequestType,
} from "@mkcode/factory-contracts";
import * as NodeTimers from "node:timers";
import * as Schema from "effect/Schema";

const DEFAULT_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAX_REQUEST_TIMEOUT_MILLISECONDS = 2_147_483_647;

const decodeHealth = Schema.decodeUnknownSync(FactoryHealth, { onExcessProperty: "error" });
const decodeCommand = Schema.decodeUnknownSync(CommandRun, { onExcessProperty: "error" });
const decodeCommandOutput = Schema.decodeUnknownSync(CommandOutputPage, {
  onExcessProperty: "error",
});
const decodeCreateResult = Schema.decodeUnknownSync(WorkflowCreateResult, {
  onExcessProperty: "error",
});
const decodeWorkflowDetail = Schema.decodeUnknownSync(WorkflowDetail, {
  onExcessProperty: "error",
});
const decodeWorkflowList = Schema.decodeUnknownSync(WorkflowListResult, {
  onExcessProperty: "error",
});
const decodeEvents = Schema.decodeUnknownSync(EventsListResult, {
  onExcessProperty: "error",
});
const decodeWorkspace = Schema.decodeUnknownSync(Workspace, { onExcessProperty: "error" });
const decodeApiError = Schema.decodeUnknownSync(FactoryApiError, {
  onExcessProperty: "error",
});
const encodeCreate = Schema.encodeSync(WorkflowCreateRequest);
const encodeCancel = Schema.encodeSync(WorkflowCancelRequest);
const encodeApproval = Schema.encodeSync(ApprovalResolveRequest);
const encodeWorkspaceAction = Schema.encodeSync(WorkspaceActionRequest);

export class FactoryWorkerClientError extends Error {
  readonly status: number;
  readonly code: FactoryApiError["code"];

  constructor(status: number, error: FactoryApiError) {
    super(error.message);
    this.name = "FactoryWorkerClientError";
    this.status = status;
    this.code = error.code;
  }
}

const responseJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new FactoryWorkerClientError(response.status, {
      code: "internal_error",
      message: "Factory worker returned a non-JSON response.",
    });
  }
};

export class FactoryWorkerClient {
  readonly #origin: string;
  readonly #credential: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;

  constructor(input: {
    readonly origin: string;
    readonly credential: string;
    readonly fetch?: typeof fetch;
    readonly timeoutMilliseconds?: number;
  }) {
    const timeoutMilliseconds = input.timeoutMilliseconds ?? DEFAULT_REQUEST_TIMEOUT_MILLISECONDS;
    if (
      !Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds <= 0 ||
      timeoutMilliseconds > MAX_REQUEST_TIMEOUT_MILLISECONDS
    ) {
      throw new TypeError(
        `Factory worker request timeout must be between 1 and ${MAX_REQUEST_TIMEOUT_MILLISECONDS} milliseconds.`,
      );
    }
    this.#origin = input.origin.replace(/\/+$/u, "");
    this.#credential = input.credential;
    this.#fetch = input.fetch ?? globalThis.fetch;
    this.#timeoutMilliseconds = timeoutMilliseconds;
  }

  async health(): Promise<FactoryHealthType> {
    return decodeHealth(await this.#request("/health"));
  }

  async createWorkflow(input: WorkflowCreateRequestType): Promise<WorkflowCreateResultType> {
    return decodeCreateResult(
      await this.#request("/v1/workflows", {
        method: "POST",
        body: JSON.stringify(encodeCreate(input)),
      }),
    );
  }

  async listWorkflows(
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<WorkflowListResultType> {
    const query = new URLSearchParams();
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return decodeWorkflowList(await this.#request(`/v1/workflows${suffix}`));
  }

  async readWorkflow(runId: string): Promise<WorkflowDetailType> {
    return decodeWorkflowDetail(await this.#request(`/v1/workflows/${encodeURIComponent(runId)}`));
  }

  async cancelWorkflow(
    runId: string,
    input: WorkflowCancelRequestType,
  ): Promise<WorkflowDetailType> {
    return decodeWorkflowDetail(
      await this.#request(`/v1/workflows/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify(encodeCancel(input)),
      }),
    );
  }

  async readCommand(commandRunId: string): Promise<CommandRunType> {
    return decodeCommand(await this.#request(`/v1/commands/${encodeURIComponent(commandRunId)}`));
  }

  async readCommandOutput(input: {
    readonly commandRunId: string;
    readonly stream: "stdout" | "stderr";
    readonly cursor?: number;
    readonly limit?: number;
  }): Promise<CommandOutputPageType> {
    const query = new URLSearchParams({ stream: input.stream });
    if (input.cursor !== undefined) query.set("cursor", String(input.cursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    return decodeCommandOutput(
      await this.#request(
        `/v1/commands/${encodeURIComponent(input.commandRunId)}/output?${query.toString()}`,
      ),
    );
  }

  async cancelCommand(
    commandRunId: string,
    input: WorkflowCancelRequestType,
  ): Promise<WorkflowDetailType> {
    return decodeWorkflowDetail(
      await this.#request(`/v1/commands/${encodeURIComponent(commandRunId)}/cancel`, {
        method: "POST",
        body: JSON.stringify(encodeCancel(input)),
      }),
    );
  }

  async readWorkflowWorkspace(workflowRunId: string): Promise<WorkspaceType> {
    return decodeWorkspace(
      await this.#request(`/v1/workflows/${encodeURIComponent(workflowRunId)}/workspace`),
    );
  }

  async readWorkspace(workspaceId: string): Promise<WorkspaceType> {
    return decodeWorkspace(
      await this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}`),
    );
  }

  async cleanupWorkspace(
    workspaceId: string,
    input: WorkspaceActionRequestType,
  ): Promise<WorkspaceType> {
    return decodeWorkspace(
      await this.#request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/cleanup`, {
        method: "POST",
        body: JSON.stringify(encodeWorkspaceAction(input)),
      }),
    );
  }

  async resolveApproval(
    approvalId: string,
    input: ApprovalResolveRequestType,
  ): Promise<WorkflowDetailType> {
    return decodeWorkflowDetail(
      await this.#request(`/v1/approvals/${encodeURIComponent(approvalId)}/resolve`, {
        method: "POST",
        body: JSON.stringify(encodeApproval(input)),
      }),
    );
  }

  async listEvents(
    input: {
      readonly afterCursor?: number;
      readonly limit?: number;
      readonly workflowRunId?: string;
    } = {},
  ): Promise<EventsListResultType> {
    const query = new URLSearchParams();
    if (input.afterCursor !== undefined) query.set("after", String(input.afterCursor));
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    if (input.workflowRunId !== undefined) query.set("runId", input.workflowRunId);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return decodeEvents(await this.#request(`/v1/events${suffix}`));
  }

  async #request(
    path: string,
    init: { readonly method?: string; readonly body?: string } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = NodeTimers.setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: controller.signal,
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      const body = await responseJson(response);
      if (!response.ok) {
        let error: FactoryApiError;
        try {
          error = decodeApiError(body);
        } catch {
          error = {
            code: "internal_error",
            message: "Factory worker request failed.",
          };
        }
        throw new FactoryWorkerClientError(response.status, error);
      }
      return body;
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new FactoryWorkerClientError(504, {
          code: "internal_error",
          message: "Factory worker request timed out.",
        });
      }
      throw cause;
    } finally {
      NodeTimers.clearTimeout(timeout);
    }
  }
}

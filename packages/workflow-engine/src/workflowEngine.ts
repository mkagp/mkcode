// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- The synchronous SQLite engine injects its clock explicitly.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  type Approval,
  type ApprovalResolveRequest,
  type Artifact,
  type Attempt,
  type EventsListResult,
  type JobIntent,
  type SimulationJobType,
  type StageKey,
  type StageRun,
  type WorkflowCancelRequest,
  type WorkflowCreateRequest,
  type WorkflowCreateResult,
  type WorkflowDetail,
  type WorkflowEvent,
  type WorkflowListResult,
  type WorkflowRun,
  WorkflowListDefaultPageSize,
  WorkflowListMaximumPageSize,
  type WorkItem,
} from "@mkcode/factory-contracts";
import { ResolvedProjectConfiguration } from "@mkcode/project-config/schema";
import * as Schema from "effect/Schema";

import { canonicalJson, digestJson } from "./canonicalJson.ts";
import { WorkflowEngineError } from "./errors.ts";
import { migration001Sql } from "./migrations/001_initial.ts";
import { ensurePrivateDirectory, ensurePrivateFile } from "./statePermissions.ts";

export const FACTORY_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_MILLISECONDS = 30_000;
export const DEFAULT_EVENT_PAGE_LIMIT = 100;
export const MAX_EVENT_PAGE_LIMIT = 500;
export const MAX_RETRY_DELAY_MILLISECONDS = 86_400_000;

const decodeProjectSnapshot = Schema.decodeUnknownSync(ResolvedProjectConfiguration, {
  onExcessProperty: "error",
  errors: "all",
});

type Clock = () => Date;
type IdGenerator = () => string;

export interface WorkflowEngineOptions {
  readonly stateDirectory: string;
  readonly databasePath?: string;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export interface ClaimedJob {
  readonly job: JobIntent;
  readonly attempt: Attempt;
  readonly stageVersion: number;
}

export interface ReconciliationResult {
  readonly reclaimedJobs: number;
  readonly cancelledJobs: number;
  readonly repairedApprovals: number;
  readonly repairedJobs: number;
  readonly operatorAttentionRuns: number;
}

type SqlRow = Record<string, unknown>;

const asString = (row: SqlRow, key: string): string => String(row[key]);
const asNumber = (row: SqlRow, key: string): number => Number(row[key]);
const optionalString = (row: SqlRow, key: string): string | undefined =>
  row[key] === null || row[key] === undefined ? undefined : String(row[key]);
const parseJson = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const terminalRunStatuses = new Set([
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "operator_attention",
]);

const stageSequence: ReadonlyArray<StageKey> = [
  "planning",
  "implementing",
  "validating",
  "human_review",
];

const jobTypeForStage = (stage: StageKey): SimulationJobType =>
  stage === "validating" ? "simulation.request-human-review" : "simulation.complete-stage";

export class WorkflowEngine {
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly schemaVersion = FACTORY_SCHEMA_VERSION;

  readonly #database: NodeSqlite.DatabaseSync;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  #closed = false;

  private constructor(
    options: WorkflowEngineOptions,
    database: NodeSqlite.DatabaseSync,
    databasePath: string,
  ) {
    this.stateDirectory = options.stateDirectory;
    this.databasePath = databasePath;
    this.#database = database;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => NodeCrypto.randomUUID());
  }

  static async open(options: WorkflowEngineOptions): Promise<WorkflowEngine> {
    const stateDirectory = NodePath.resolve(options.stateDirectory);
    const databasePath = options.databasePath ?? NodePath.join(stateDirectory, "factory.sqlite");
    if (!NodePath.isAbsolute(databasePath)) {
      throw new WorkflowEngineError("invalid_request", "Factory database path must be absolute.");
    }
    const databaseRelativePath = NodePath.relative(stateDirectory, databasePath);
    if (
      databaseRelativePath === ".." ||
      databaseRelativePath.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(databaseRelativePath)
    ) {
      throw new WorkflowEngineError(
        "invalid_request",
        "Factory database path must remain inside the factory state directory.",
      );
    }
    await ensurePrivateDirectory(stateDirectory);
    await ensurePrivateDirectory(NodePath.dirname(databasePath));
    await ensurePrivateFile(databasePath, true);

    const database = new NodeSqlite.DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = ON;");
      database.exec("PRAGMA journal_mode = WAL;");
      const currentVersion = Number(
        (database.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ??
          0,
      );
      if (currentVersion > FACTORY_SCHEMA_VERSION) {
        throw new WorkflowEngineError(
          "unsupported_schema",
          `Factory schema ${currentVersion} is newer than supported schema ${FACTORY_SCHEMA_VERSION}.`,
          { currentVersion, supportedVersion: FACTORY_SCHEMA_VERSION },
        );
      }
      if (currentVersion < 1) {
        database.exec("BEGIN EXCLUSIVE;");
        try {
          database.exec(migration001Sql);
          database.exec(`PRAGMA user_version = ${FACTORY_SCHEMA_VERSION};`);
          database.exec("COMMIT;");
        } catch (cause) {
          database.exec("ROLLBACK;");
          throw cause;
        }
      }
      await ensurePrivateFile(databasePath, false);
      await ensurePrivateFile(`${databasePath}-wal`, false);
      await ensurePrivateFile(`${databasePath}-shm`, false);
      return new WorkflowEngine({ ...options, stateDirectory }, database, databasePath);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  createWorkflow(input: WorkflowCreateRequest): WorkflowCreateResult {
    this.#assertOpen();
    this.#assertCreateInput(input);
    const requestDigest = digestJson(input);
    const existing = this.#database
      .prepare(
        "SELECT request_digest, stored_result_reference FROM idempotency_records WHERE scope = ? AND key = ?",
      )
      .get("workflow.create", input.idempotencyKey) as SqlRow | undefined;
    if (existing) {
      if (asString(existing, "request_digest") !== requestDigest) {
        throw new WorkflowEngineError(
          "conflict",
          "The idempotency key was already used with different workflow input.",
          { scope: "workflow.create", key: input.idempotencyKey },
        );
      }
      return {
        ...this.#readCreateResult(asString(existing, "stored_result_reference")),
        replayed: true,
      };
    }

    return this.#transaction(() => {
      const raced = this.#database
        .prepare(
          "SELECT request_digest, stored_result_reference FROM idempotency_records WHERE scope = ? AND key = ?",
        )
        .get("workflow.create", input.idempotencyKey) as SqlRow | undefined;
      if (raced) {
        if (asString(raced, "request_digest") !== requestDigest) {
          throw new WorkflowEngineError("conflict", "Conflicting idempotent workflow creation.");
        }
        return {
          ...this.#readCreateResult(asString(raced, "stored_result_reference")),
          replayed: true,
        };
      }

      const now = this.#now();
      const workItemId = input.workItem.id ?? this.#idGenerator();
      const runId = this.#idGenerator();
      const stageId = this.#idGenerator();
      const jobId = this.#idGenerator();
      const snapshotDigest = digestJson(input.projectSnapshot);

      const existingWorkItem = this.#database
        .prepare("SELECT * FROM work_items WHERE id = ?")
        .get(workItemId) as SqlRow | undefined;
      if (existingWorkItem) {
        const stored = this.#mapWorkItem(existingWorkItem);
        const requestedReference = input.workItem.externalReference ?? undefined;
        if (
          stored.projectId !== input.workItem.projectId ||
          stored.title !== input.workItem.title ||
          stored.description !== input.workItem.description ||
          stored.source !== input.workItem.source ||
          canonicalJson(stored.externalReference ?? null) !==
            canonicalJson(requestedReference ?? null)
        ) {
          throw new WorkflowEngineError(
            "conflict",
            "The supplied WorkItem ID already refers to different content.",
          );
        }
      } else {
        this.#database
          .prepare(
            `INSERT INTO work_items
              (id, project_id, title, description, source, created_at, external_reference_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workItemId,
            input.workItem.projectId,
            input.workItem.title,
            input.workItem.description,
            input.workItem.source,
            now,
            input.workItem.externalReference
              ? canonicalJson(input.workItem.externalReference)
              : null,
          );
      }
      this.#database
        .prepare(
          `INSERT INTO workflow_runs
            (id, work_item_id, project_id, workflow_type, status, requested_by, created_at,
             updated_at, project_snapshot_json, snapshot_digest, version)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          runId,
          workItemId,
          input.workItem.projectId,
          input.workflowType,
          input.requestedBy,
          now,
          now,
          canonicalJson(input.projectSnapshot),
          snapshotDigest,
        );
      this.#insertStage({
        id: stageId,
        runId,
        stageKey: "planning",
        sequence: 1,
        now,
      });
      this.#insertJob({
        id: jobId,
        runId,
        stageId,
        stageKey: "planning",
        now,
      });
      this.#insertEvent(runId, "workflow.created", {
        workItemId,
        projectId: input.workItem.projectId,
        workflowType: input.workflowType,
      });
      this.#insertEvent(runId, "stage.queued", {
        stageRunId: stageId,
        stageKey: "planning",
        sequence: 1,
      });
      this.#insertEvent(runId, "job.pending", {
        jobId,
        stageRunId: stageId,
        jobType: jobTypeForStage("planning"),
      });
      this.#database
        .prepare(
          `INSERT INTO idempotency_records
            (scope, key, request_digest, stored_result_reference, created_at)
           VALUES ('workflow.create', ?, ?, ?, ?)`,
        )
        .run(input.idempotencyKey, requestDigest, runId, now);

      return { ...this.#readCreateResult(runId), replayed: false };
    });
  }

  listWorkflows(): ReadonlyArray<WorkflowRun> {
    this.#assertOpen();
    return (
      this.#database
        .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC, id DESC")
        .all() as ReadonlyArray<SqlRow>
    ).map(this.#mapWorkflowRun);
  }

  listWorkflowPage(
    input: {
      readonly cursor?: number;
      readonly limit?: number;
    } = {},
  ): WorkflowListResult {
    this.#assertOpen();
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? WorkflowListDefaultPageSize;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new WorkflowEngineError("invalid_cursor", "Workflow-list cursor is invalid.");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > WorkflowListMaximumPageSize) {
      throw new WorkflowEngineError("invalid_request", "Workflow-list page limit is invalid.");
    }
    const rows = this.#database
      .prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit + 1, cursor) as ReadonlyArray<SqlRow>;
    const hasMore = rows.length > limit;
    const runs = rows.slice(0, limit).map(this.#mapWorkflowRun);
    return {
      runs,
      nextCursor: cursor + runs.length,
      hasMore,
    };
  }

  readWorkflow(runId: string): WorkflowDetail {
    this.#assertOpen();
    const workflowRun = this.#findWorkflowRun(runId);
    const workItemRow = this.#database
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(workflowRun.workItemId) as SqlRow | undefined;
    if (!workItemRow) {
      throw new WorkflowEngineError("not_found", "Workflow work item was not found.");
    }
    const stages = (
      this.#database
        .prepare("SELECT * FROM stage_runs WHERE workflow_run_id = ? ORDER BY sequence")
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapStageRun);
    const attempts = (
      this.#database
        .prepare(
          `SELECT attempts.* FROM attempts
           JOIN stage_runs ON stage_runs.id = attempts.stage_run_id
           WHERE stage_runs.workflow_run_id = ?
           ORDER BY stage_runs.sequence, attempts.attempt_number`,
        )
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapAttempt);
    const jobs = (
      this.#database
        .prepare("SELECT * FROM job_intents WHERE workflow_run_id = ? ORDER BY created_at, id")
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapJob);
    const approvals = (
      this.#database
        .prepare("SELECT * FROM approvals WHERE workflow_run_id = ? ORDER BY requested_at, id")
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapApproval);
    const artifacts = (
      this.#database
        .prepare("SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY created_at, id")
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapArtifact);
    return {
      workItem: this.#mapWorkItem(workItemRow),
      workflowRun,
      stages,
      attempts,
      jobs,
      approvals,
      artifacts,
    };
  }

  claimNextJob(
    leaseOwner: string,
    leaseMilliseconds = DEFAULT_LEASE_MILLISECONDS,
  ): ClaimedJob | undefined {
    this.#assertOpen();
    if (
      leaseOwner.trim().length === 0 ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds <= 0
    ) {
      throw new WorkflowEngineError(
        "invalid_request",
        "A lease owner and positive lease are required.",
      );
    }
    return this.#transaction(() => {
      const now = this.#now();
      const expiration = new Date(this.#clock().getTime() + leaseMilliseconds).toISOString();
      const row = this.#database
        .prepare(
          `SELECT job_intents.*
           FROM job_intents
           JOIN workflow_runs ON workflow_runs.id = job_intents.workflow_run_id
           WHERE workflow_runs.cancellation_requested_at IS NULL
             AND workflow_runs.status NOT IN ('completed','rejected','failed','cancelled','operator_attention')
             AND (
               (job_intents.status = 'pending' AND job_intents.available_after <= ?)
               OR (job_intents.status = 'claimed' AND job_intents.lease_expiration <= ?)
             )
           ORDER BY job_intents.available_after, job_intents.created_at, job_intents.id
           LIMIT 1`,
        )
        .get(now, now) as SqlRow | undefined;
      if (!row) return undefined;

      const jobId = asString(row, "id");
      const stageId = asString(row, "stage_run_id");
      const priorAttempt = this.#database
        .prepare(
          "SELECT id FROM attempts WHERE stage_run_id = ? ORDER BY attempt_number DESC LIMIT 1",
        )
        .get(stageId) as SqlRow | undefined;
      const attemptNumber = asNumber(row, "attempt_count") + 1;
      const update = this.#database
        .prepare(
          `UPDATE job_intents
           SET status = 'claimed', lease_owner = ?, lease_expiration = ?,
               attempt_count = ?, updated_at = ?
           WHERE id = ? AND (
             (status = 'pending' AND available_after <= ?)
             OR (status = 'claimed' AND lease_expiration <= ?)
           )`,
        )
        .run(leaseOwner, expiration, attemptNumber, now, jobId, now, now);
      if (Number(update.changes) !== 1) return undefined;

      if (asString(row, "status") === "claimed") {
        this.#database
          .prepare(
            `UPDATE attempts
             SET status = 'expired', completed_at = ?
             WHERE stage_run_id = ? AND attempt_number = ? AND status = 'running'`,
          )
          .run(now, stageId, asNumber(row, "attempt_count"));
        this.#insertEvent(asString(row, "workflow_run_id"), "job.lease_expired", {
          jobId,
        });
      }

      const attemptId = this.#idGenerator();
      this.#database
        .prepare(
          `INSERT INTO attempts
            (id, stage_run_id, attempt_number, status, created_at, started_at, retry_of_attempt_id)
           VALUES (?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          attemptId,
          stageId,
          attemptNumber,
          now,
          now,
          priorAttempt ? asString(priorAttempt, "id") : null,
        );
      this.#database
        .prepare(
          `UPDATE stage_runs
           SET status = 'running', current_attempt = ?, started_at = COALESCE(started_at, ?),
               version = version + 1
           WHERE id = ?`,
        )
        .run(attemptNumber, now, stageId);
      const stage = this.#findStage(stageId);
      this.#database
        .prepare(
          `UPDATE workflow_runs SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(stage.stageKey, now, stage.workflowRunId);
      this.#insertEvent(stage.workflowRunId, "job.claimed", {
        jobId,
        stageRunId: stageId,
        attemptId,
        attemptNumber,
        leaseOwner,
        leaseExpiration: expiration,
      });
      return {
        job: this.#findJob(jobId),
        attempt: this.#findAttempt(attemptId),
        stageVersion: this.#findStage(stageId).version,
      };
    });
  }

  renewLease(jobId: string, leaseOwner: string, leaseMilliseconds: number): JobIntent {
    if (
      leaseOwner.trim().length === 0 ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds <= 0
    ) {
      throw new WorkflowEngineError(
        "invalid_request",
        "A lease owner and positive safe-integer lease are required.",
      );
    }
    return this.#transaction(() => {
      const now = this.#now();
      const expiration = new Date(this.#clock().getTime() + leaseMilliseconds).toISOString();
      const result = this.#database
        .prepare(
          `UPDATE job_intents SET lease_expiration = ?, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND lease_owner = ? AND lease_expiration > ?`,
        )
        .run(expiration, now, jobId, leaseOwner, now);
      if (Number(result.changes) !== 1) {
        throw new WorkflowEngineError(
          "conflict",
          "The job lease is missing, expired, or owned elsewhere.",
        );
      }
      const job = this.#findJob(jobId);
      this.#insertEvent(job.workflowRunId, "job.lease_renewed", {
        jobId,
        leaseOwner,
        leaseExpiration: expiration,
      });
      return this.#findJob(jobId);
    });
  }

  completeJob(
    jobId: string,
    leaseOwner: string,
    completionMetadata: Readonly<Record<string, unknown>>,
    expectedStageVersion: number,
  ): WorkflowDetail {
    const completionMetadataJson = canonicalJson(completionMetadata);
    const completionDigest = digestJson(completionMetadata);
    return this.#transaction(() => {
      const job = this.#findJob(jobId);
      if (job.status === "completed") {
        const completion = this.#database
          .prepare(
            `SELECT completion_owner, completion_stage_version, completion_digest
             FROM job_intents WHERE id = ?`,
          )
          .get(jobId) as SqlRow | undefined;
        if (
          completion &&
          optionalString(completion, "completion_owner") === leaseOwner &&
          asNumber(completion, "completion_stage_version") === expectedStageVersion &&
          optionalString(completion, "completion_digest") === completionDigest
        ) {
          return this.readWorkflow(job.workflowRunId);
        }
        throw new WorkflowEngineError(
          "conflict",
          "Completed job replay does not match the original completion.",
        );
      }
      const now = this.#now();
      if (
        job.status !== "claimed" ||
        job.leaseOwner !== leaseOwner ||
        job.leaseExpiration === undefined ||
        job.leaseExpiration <= now
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Only the current owner of an active lease may complete the job.",
        );
      }
      const run = this.#findWorkflowRun(job.workflowRunId);
      if (run.cancellationRequestedAt) {
        this.#cancelRunInTransaction(run.id, run.cancellationRequestedBy ?? "unknown");
        return this.readWorkflow(run.id);
      }
      const stage = this.#findStage(job.stageRunId);
      if (stage.version !== expectedStageVersion) {
        throw new WorkflowEngineError(
          "stale_version",
          "The stage changed after the job was claimed.",
          {
            expectedVersion: expectedStageVersion,
            currentVersion: stage.version,
          },
        );
      }
      if (stage.status !== "running") {
        throw new WorkflowEngineError(
          "invalid_transition",
          "The claimed job stage is not running.",
        );
      }
      this.#database
        .prepare(
          `UPDATE job_intents
           SET status = 'completed', lease_owner = NULL, lease_expiration = NULL,
               completion_metadata_json = ?, completion_owner = ?,
               completion_stage_version = ?, completion_digest = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          completionMetadataJson,
          leaseOwner,
          expectedStageVersion,
          completionDigest,
          now,
          jobId,
        );
      this.#database
        .prepare(
          `UPDATE attempts SET status = 'completed', completed_at = ?
           WHERE stage_run_id = ? AND attempt_number = ?`,
        )
        .run(now, stage.id, stage.currentAttempt);
      this.#database
        .prepare(
          `UPDATE stage_runs
           SET status = 'completed', completed_at = ?, outcome = 'succeeded', version = version + 1
           WHERE id = ?`,
        )
        .run(now, stage.id);
      this.#insertEvent(run.id, "job.completed", { jobId, stageRunId: stage.id });
      this.#insertEvent(run.id, "stage.completed", {
        stageRunId: stage.id,
        stageKey: stage.stageKey,
      });

      const nextStage = stageSequence[stage.sequence];
      if (!nextStage) {
        throw new WorkflowEngineError(
          "invalid_transition",
          "No transition exists after this stage.",
        );
      }
      const nextStageId = this.#idGenerator();
      this.#insertStage({
        id: nextStageId,
        runId: run.id,
        stageKey: nextStage,
        sequence: stage.sequence + 1,
        now,
      });
      if (nextStage === "human_review") {
        const approvalId = this.#idGenerator();
        this.#database
          .prepare(
            `INSERT INTO approvals
              (id, workflow_run_id, stage_run_id, approval_type, status, requested_at)
             VALUES (?, ?, ?, 'human_review', 'pending', ?)`,
          )
          .run(approvalId, run.id, nextStageId, now);
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = 'waiting_approval', version = version + 1 WHERE id = ?`,
          )
          .run(nextStageId);
        this.#database
          .prepare(
            `UPDATE workflow_runs
             SET status = 'human_review', updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(now, run.id);
        this.#insertEvent(run.id, "approval.requested", {
          approvalId,
          stageRunId: nextStageId,
          approvalType: "human_review",
        });
      } else {
        const nextJobId = this.#idGenerator();
        this.#insertJob({
          id: nextJobId,
          runId: run.id,
          stageId: nextStageId,
          stageKey: nextStage,
          now,
        });
        this.#database
          .prepare(
            `UPDATE workflow_runs SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(nextStage, now, run.id);
        this.#insertEvent(run.id, "stage.queued", {
          stageRunId: nextStageId,
          stageKey: nextStage,
          sequence: stage.sequence + 1,
        });
        this.#insertEvent(run.id, "job.pending", {
          jobId: nextJobId,
          stageRunId: nextStageId,
          jobType: jobTypeForStage(nextStage),
        });
      }
      return this.readWorkflow(run.id);
    });
  }

  failJob(input: {
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly retryable: boolean;
    readonly failureSummary: string;
    readonly retryDelayMilliseconds?: number;
    readonly maximumAttempts?: number;
    readonly expectedStageVersion: number;
  }): JobIntent {
    const maximumAttempts = input.maximumAttempts ?? 3;
    const retryDelayMilliseconds = input.retryDelayMilliseconds ?? 0;
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts <= 0) {
      throw new WorkflowEngineError(
        "invalid_request",
        "Maximum attempts must be a positive safe integer.",
      );
    }
    if (
      !Number.isSafeInteger(retryDelayMilliseconds) ||
      retryDelayMilliseconds < 0 ||
      retryDelayMilliseconds > MAX_RETRY_DELAY_MILLISECONDS
    ) {
      throw new WorkflowEngineError(
        "invalid_request",
        `Retry delay must be a safe integer between 0 and ${MAX_RETRY_DELAY_MILLISECONDS}.`,
      );
    }
    return this.#transaction(() => {
      const job = this.#findJob(input.jobId);
      const now = this.#now();
      if (
        job.status !== "claimed" ||
        job.leaseOwner !== input.leaseOwner ||
        job.leaseExpiration === undefined ||
        job.leaseExpiration <= now
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Only the current owner of an active lease may fail the job.",
        );
      }
      const stage = this.#findStage(job.stageRunId);
      if (stage.version !== input.expectedStageVersion) {
        throw new WorkflowEngineError(
          "stale_version",
          "The stage changed after the job was claimed.",
          {
            expectedVersion: input.expectedStageVersion,
            currentVersion: stage.version,
          },
        );
      }
      this.#database
        .prepare(
          `UPDATE attempts
           SET status = 'failed', completed_at = ?, failure_summary = ?
           WHERE stage_run_id = ? AND attempt_number = ?`,
        )
        .run(now, input.failureSummary, job.stageRunId, job.attemptCount);
      if (input.retryable && job.attemptCount < maximumAttempts) {
        const availableAfter = new Date(
          this.#clock().getTime() + retryDelayMilliseconds,
        ).toISOString();
        this.#database
          .prepare(
            `UPDATE job_intents
             SET status = 'pending', available_after = ?, lease_owner = NULL,
                 lease_expiration = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(availableAfter, now, job.id);
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = 'queued', failure_classification = 'retryable',
             version = version + 1 WHERE id = ?`,
          )
          .run(job.stageRunId);
        this.#insertEvent(job.workflowRunId, "job.retry_scheduled", {
          jobId: job.id,
          attemptCount: job.attemptCount,
          availableAfter,
          failureSummary: input.failureSummary,
        });
      } else {
        this.#database
          .prepare(
            `UPDATE job_intents
             SET status = 'failed', terminal_failure = ?, lease_owner = NULL,
                 lease_expiration = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.failureSummary, now, job.id);
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = 'failed', completed_at = ?, outcome = 'failed',
             failure_classification = ?, version = version + 1 WHERE id = ?`,
          )
          .run(now, input.retryable ? "maximum_attempts_exhausted" : "terminal", job.stageRunId);
        this.#database
          .prepare(
            `UPDATE workflow_runs SET status = 'failed', terminal_outcome = 'failed',
             updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(now, job.workflowRunId);
        this.#insertEvent(job.workflowRunId, "workflow.failed", {
          jobId: job.id,
          failureSummary: input.failureSummary,
          classification: input.retryable ? "maximum_attempts_exhausted" : "terminal",
        });
      }
      return this.#findJob(job.id);
    });
  }

  cancelWorkflow(runId: string, input: WorkflowCancelRequest): WorkflowDetail {
    return this.#transaction(() => {
      const run = this.#findWorkflowRun(runId);
      if (run.status === "cancelled") return this.readWorkflow(runId);
      if (terminalRunStatuses.has(run.status)) {
        throw new WorkflowEngineError(
          "invalid_transition",
          "A terminal workflow cannot be cancelled.",
        );
      }
      this.#cancelRunInTransaction(runId, input.requestedBy);
      return this.readWorkflow(runId);
    });
  }

  resolveApproval(approvalId: string, input: ApprovalResolveRequest): WorkflowDetail {
    return this.#transaction(() => {
      const approval = this.#findApproval(approvalId);
      if (approval.status !== "pending") {
        if (approval.status === input.decision) return this.readWorkflow(approval.workflowRunId);
        throw new WorkflowEngineError(
          "conflict",
          "The approval already has a conflicting decision.",
        );
      }
      const run = this.#findWorkflowRun(approval.workflowRunId);
      if (run.cancellationRequestedAt || run.status === "cancelled") {
        throw new WorkflowEngineError(
          "invalid_transition",
          "A cancelled workflow cannot be approved.",
        );
      }
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, rationale = ?
           WHERE id = ?`,
        )
        .run(input.decision, now, input.resolvedBy, input.rationale ?? null, approvalId);
      this.#database
        .prepare(
          `UPDATE stage_runs SET status = ?, completed_at = ?, outcome = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(
          input.decision === "approved" ? "completed" : "failed",
          now,
          input.decision,
          approval.stageRunId,
        );
      this.#database
        .prepare(
          `UPDATE workflow_runs
           SET status = ?, terminal_outcome = ?, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(
          input.decision === "approved" ? "completed" : "rejected",
          input.decision === "approved" ? "completed" : "rejected",
          now,
          approval.workflowRunId,
        );
      this.#insertEvent(approval.workflowRunId, "approval.resolved", {
        approvalId,
        decision: input.decision,
        resolvedBy: input.resolvedBy,
      });
      this.#insertEvent(
        approval.workflowRunId,
        input.decision === "approved" ? "workflow.completed" : "workflow.rejected",
        { approvalId },
      );
      return this.readWorkflow(approval.workflowRunId);
    });
  }

  listEvents(input: {
    readonly afterCursor?: number;
    readonly limit?: number;
    readonly workflowRunId?: string;
  }): EventsListResult {
    this.#assertOpen();
    const afterCursor = input.afterCursor ?? 0;
    const limit = input.limit ?? DEFAULT_EVENT_PAGE_LIMIT;
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new WorkflowEngineError(
        "invalid_cursor",
        "Event cursor must be a non-negative integer.",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE_LIMIT) {
      throw new WorkflowEngineError(
        "invalid_request",
        `Event page limit must be between 1 and ${MAX_EVENT_PAGE_LIMIT}.`,
      );
    }
    const rows = input.workflowRunId
      ? (this.#database
          .prepare(
            `SELECT * FROM workflow_events
             WHERE cursor > ? AND workflow_run_id = ? ORDER BY cursor LIMIT ?`,
          )
          .all(afterCursor, input.workflowRunId, limit) as ReadonlyArray<SqlRow>)
      : (this.#database
          .prepare("SELECT * FROM workflow_events WHERE cursor > ? ORDER BY cursor LIMIT ?")
          .all(afterCursor, limit) as ReadonlyArray<SqlRow>);
    const events = rows.map(this.#mapEvent);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? afterCursor,
    };
  }

  reconcile(): ReconciliationResult {
    return this.#transaction(() => {
      const now = this.#now();
      let reclaimedJobs = 0;
      let cancelledJobs = 0;
      let repairedApprovals = 0;
      let repairedJobs = 0;
      let operatorAttentionRuns = 0;

      const expired = this.#database
        .prepare(
          `SELECT * FROM job_intents
           WHERE status = 'claimed' AND lease_expiration <= ? ORDER BY id`,
        )
        .all(now) as ReadonlyArray<SqlRow>;
      for (const row of expired) {
        const job = this.#mapJob(row);
        this.#database
          .prepare(
            `UPDATE job_intents SET status = 'pending', lease_owner = NULL,
             lease_expiration = NULL, available_after = ?, updated_at = ? WHERE id = ?`,
          )
          .run(now, now, job.id);
        this.#database
          .prepare(
            `UPDATE attempts SET status = 'expired', completed_at = ? WHERE stage_run_id = ?
             AND attempt_number = ? AND status = 'running'`,
          )
          .run(now, job.stageRunId, job.attemptCount);
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = 'queued', version = version + 1
             WHERE id = ? AND status = 'running'`,
          )
          .run(job.stageRunId);
        this.#insertEvent(job.workflowRunId, "job.lease_expired", { jobId: job.id });
        reclaimedJobs += 1;
      }

      const cancelled = this.#database
        .prepare(
          `SELECT job_intents.id, job_intents.workflow_run_id
           FROM job_intents JOIN workflow_runs ON workflow_runs.id = job_intents.workflow_run_id
           WHERE workflow_runs.cancellation_requested_at IS NOT NULL
             AND job_intents.status IN ('pending','claimed')`,
        )
        .all() as ReadonlyArray<SqlRow>;
      for (const row of cancelled) {
        this.#database
          .prepare(
            `UPDATE job_intents SET status = 'cancelled', lease_owner = NULL,
             lease_expiration = NULL, updated_at = ? WHERE id = ?`,
          )
          .run(now, asString(row, "id"));
        cancelledJobs += 1;
      }

      const reviewStages = this.#database
        .prepare(
          `SELECT stage_runs.* FROM stage_runs
           LEFT JOIN approvals ON approvals.stage_run_id = stage_runs.id
           WHERE stage_runs.stage_key = 'human_review'
             AND stage_runs.status = 'waiting_approval'
             AND approvals.id IS NULL`,
        )
        .all() as ReadonlyArray<SqlRow>;
      for (const row of reviewStages) {
        const stage = this.#mapStageRun(row);
        const approvalId = this.#idGenerator();
        this.#database
          .prepare(
            `INSERT INTO approvals
              (id, workflow_run_id, stage_run_id, approval_type, status, requested_at)
             VALUES (?, ?, ?, 'human_review', 'pending', ?)`,
          )
          .run(approvalId, stage.workflowRunId, stage.id, now);
        this.#insertEvent(stage.workflowRunId, "approval.recovered", {
          approvalId,
          stageRunId: stage.id,
        });
        repairedApprovals += 1;
      }

      const missingJobs = this.#database
        .prepare(
          `SELECT stage_runs.* FROM stage_runs
           JOIN workflow_runs ON workflow_runs.id = stage_runs.workflow_run_id
           LEFT JOIN job_intents ON job_intents.stage_run_id = stage_runs.id
             AND job_intents.status IN ('pending','claimed')
           WHERE stage_runs.stage_key != 'human_review'
             AND stage_runs.status = 'queued'
             AND workflow_runs.status NOT IN ('completed','rejected','failed','cancelled','operator_attention')
             AND job_intents.id IS NULL`,
        )
        .all() as ReadonlyArray<SqlRow>;
      for (const row of missingJobs) {
        const stage = this.#mapStageRun(row);
        this.#insertJob({
          id: this.#idGenerator(),
          runId: stage.workflowRunId,
          stageId: stage.id,
          stageKey: stage.stageKey,
          now,
        });
        this.#insertEvent(stage.workflowRunId, "job.recovered", { stageRunId: stage.id });
        repairedJobs += 1;
      }

      const ambiguous = this.#database
        .prepare(
          `SELECT DISTINCT workflow_runs.id
           FROM workflow_runs
           JOIN stage_runs ON stage_runs.workflow_run_id = workflow_runs.id
           JOIN job_intents ON job_intents.stage_run_id = stage_runs.id
           WHERE workflow_runs.status NOT IN ('completed','rejected','failed','cancelled','operator_attention')
             AND stage_runs.status = 'running'
             AND job_intents.status = 'completed'`,
        )
        .all() as ReadonlyArray<SqlRow>;
      for (const row of ambiguous) {
        const runId = asString(row, "id");
        this.#database
          .prepare(
            `UPDATE workflow_runs SET status = 'operator_attention',
             terminal_outcome = 'operator_attention', updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(now, runId);
        this.#insertEvent(runId, "workflow.operator_attention", {
          reason: "completed_job_without_committed_transition",
        });
        operatorAttentionRuns += 1;
      }

      return {
        reclaimedJobs,
        cancelledJobs,
        repairedApprovals,
        repairedJobs,
        operatorAttentionRuns,
      };
    });
  }

  #transaction<A>(body: () => A): A {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const value = body();
      this.#database.exec("COMMIT;");
      return value;
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WorkflowEngineError("internal_error", "The workflow engine is closed.");
    }
  }

  #assertCreateInput(input: WorkflowCreateRequest): void {
    if (
      input.idempotencyKey.trim().length === 0 ||
      input.workItem.projectId.trim().length === 0 ||
      input.workItem.title.trim().length === 0 ||
      input.workflowType.trim().length === 0 ||
      input.requestedBy.trim().length === 0
    ) {
      throw new WorkflowEngineError(
        "invalid_request",
        "Required workflow fields must not be empty.",
      );
    }
    try {
      decodeProjectSnapshot(input.projectSnapshot);
    } catch {
      throw new WorkflowEngineError("invalid_request", "The resolved project snapshot is invalid.");
    }
    if (input.projectSnapshot.project.id !== input.workItem.projectId) {
      throw new WorkflowEngineError(
        "invalid_request",
        "The work-item project must match the resolved project snapshot.",
      );
    }
    if (!input.projectSnapshot.workflows.allowed.includes(input.workflowType)) {
      throw new WorkflowEngineError(
        "invalid_request",
        "The requested workflow is not allowed by the resolved project snapshot.",
      );
    }
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #insertStage(input: {
    readonly id: string;
    readonly runId: string;
    readonly stageKey: StageKey;
    readonly sequence: number;
    readonly now: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO stage_runs
          (id, workflow_run_id, stage_key, sequence, status, current_attempt, created_at, version)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, 1)`,
      )
      .run(input.id, input.runId, input.stageKey, input.sequence, input.now);
  }

  #insertJob(input: {
    readonly id: string;
    readonly runId: string;
    readonly stageId: string;
    readonly stageKey: StageKey;
    readonly now: string;
  }): void {
    this.#database
      .prepare(
        `INSERT INTO job_intents
          (id, workflow_run_id, stage_run_id, job_type, payload_version, payload_json,
           status, idempotency_key, available_after, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, 'pending', ?, ?, 0, ?, ?)`,
      )
      .run(
        input.id,
        input.runId,
        input.stageId,
        jobTypeForStage(input.stageKey),
        canonicalJson({ stageKey: input.stageKey }),
        `${input.runId}:${input.stageId}:${jobTypeForStage(input.stageKey)}`,
        input.now,
        input.now,
        input.now,
      );
  }

  #insertEvent(runId: string, eventType: string, payload: Readonly<Record<string, unknown>>): void {
    this.#database
      .prepare(
        `INSERT INTO workflow_events
          (id, workflow_run_id, event_type, schema_version, payload_json, timestamp)
         VALUES (?, ?, ?, 1, ?, ?)`,
      )
      .run(this.#idGenerator(), runId, eventType, canonicalJson(payload), this.#now());
  }

  #cancelRunInTransaction(runId: string, requestedBy: string): void {
    const run = this.#findWorkflowRun(runId);
    if (run.status === "cancelled") return;
    const now = this.#now();
    this.#database
      .prepare(
        `UPDATE workflow_runs
         SET status = 'cancelled', cancellation_requested_at = ?,
             cancellation_requested_by = ?, terminal_outcome = 'cancelled',
             updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(now, requestedBy, now, runId);
    this.#database
      .prepare(
        `UPDATE job_intents SET status = 'cancelled', lease_owner = NULL,
         lease_expiration = NULL, updated_at = ?
         WHERE workflow_run_id = ? AND status IN ('pending','claimed')`,
      )
      .run(now, runId);
    this.#database
      .prepare(
        `UPDATE attempts SET status = 'cancelled', completed_at = ?
         WHERE stage_run_id IN (SELECT id FROM stage_runs WHERE workflow_run_id = ?)
           AND status = 'running'`,
      )
      .run(now, runId);
    this.#database
      .prepare(
        `UPDATE stage_runs SET status = 'cancelled', completed_at = ?,
         outcome = 'cancelled', version = version + 1
         WHERE workflow_run_id = ? AND status IN ('queued','running','waiting_approval')`,
      )
      .run(now, runId);
    this.#database
      .prepare(
        `UPDATE approvals SET status = 'cancelled', resolved_at = ?, resolved_by = ?
         WHERE workflow_run_id = ? AND status = 'pending'`,
      )
      .run(now, requestedBy, runId);
    this.#insertEvent(runId, "workflow.cancelled", { requestedBy });
  }

  #readCreateResult(runId: string): Omit<WorkflowCreateResult, "replayed"> {
    const detail = this.readWorkflow(runId);
    const stageRun = detail.stages[0];
    const jobIntent = detail.jobs[0];
    if (!stageRun || !jobIntent) {
      throw new WorkflowEngineError("internal_error", "Workflow creation result is incomplete.");
    }
    return {
      workItem: detail.workItem,
      workflowRun: detail.workflowRun,
      stageRun,
      jobIntent,
    };
  }

  #findWorkflowRun(runId: string): WorkflowRun {
    const row = this.#database.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as
      | SqlRow
      | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Workflow run was not found.");
    return this.#mapWorkflowRun(row);
  }

  #findStage(stageId: string): StageRun {
    const row = this.#database.prepare("SELECT * FROM stage_runs WHERE id = ?").get(stageId) as
      | SqlRow
      | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Stage run was not found.");
    return this.#mapStageRun(row);
  }

  #findJob(jobId: string): JobIntent {
    const row = this.#database.prepare("SELECT * FROM job_intents WHERE id = ?").get(jobId) as
      | SqlRow
      | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Job intent was not found.");
    return this.#mapJob(row);
  }

  #findAttempt(attemptId: string): Attempt {
    const row = this.#database.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId) as
      | SqlRow
      | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Attempt was not found.");
    return this.#mapAttempt(row);
  }

  #findApproval(approvalId: string): Approval {
    const row = this.#database.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as
      | SqlRow
      | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Approval was not found.");
    return this.#mapApproval(row);
  }

  readonly #mapWorkItem = (row: SqlRow): WorkItem => ({
    id: asString(row, "id"),
    projectId: asString(row, "project_id"),
    title: asString(row, "title"),
    description: asString(row, "description"),
    source: asString(row, "source") as WorkItem["source"],
    createdAt: asString(row, "created_at"),
    ...(row.external_reference_json
      ? { externalReference: parseJson<Record<string, string>>(row.external_reference_json) }
      : {}),
  });

  readonly #mapWorkflowRun = (row: SqlRow): WorkflowRun => ({
    id: asString(row, "id"),
    workItemId: asString(row, "work_item_id"),
    projectId: asString(row, "project_id"),
    workflowType: asString(row, "workflow_type"),
    status: asString(row, "status") as WorkflowRun["status"],
    requestedBy: asString(row, "requested_by"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    projectSnapshot: parseJson<WorkflowRun["projectSnapshot"]>(row.project_snapshot_json),
    snapshotDigest: asString(row, "snapshot_digest"),
    ...(optionalString(row, "cancellation_requested_at")
      ? { cancellationRequestedAt: optionalString(row, "cancellation_requested_at") }
      : {}),
    ...(optionalString(row, "cancellation_requested_by")
      ? { cancellationRequestedBy: optionalString(row, "cancellation_requested_by") }
      : {}),
    ...(optionalString(row, "terminal_outcome")
      ? {
          terminalOutcome: optionalString(
            row,
            "terminal_outcome",
          ) as WorkflowRun["terminalOutcome"],
        }
      : {}),
    version: asNumber(row, "version"),
  });

  readonly #mapStageRun = (row: SqlRow): StageRun => ({
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    stageKey: asString(row, "stage_key") as StageKey,
    sequence: asNumber(row, "sequence"),
    status: asString(row, "status") as StageRun["status"],
    currentAttempt: asNumber(row, "current_attempt"),
    createdAt: asString(row, "created_at"),
    ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at") } : {}),
    ...(optionalString(row, "completed_at")
      ? { completedAt: optionalString(row, "completed_at") }
      : {}),
    ...(optionalString(row, "outcome") ? { outcome: optionalString(row, "outcome") } : {}),
    ...(optionalString(row, "failure_classification")
      ? { failureClassification: optionalString(row, "failure_classification") }
      : {}),
    version: asNumber(row, "version"),
  });

  readonly #mapAttempt = (row: SqlRow): Attempt => ({
    id: asString(row, "id"),
    stageRunId: asString(row, "stage_run_id"),
    attemptNumber: asNumber(row, "attempt_number"),
    status: asString(row, "status") as Attempt["status"],
    createdAt: asString(row, "created_at"),
    ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at") } : {}),
    ...(optionalString(row, "completed_at")
      ? { completedAt: optionalString(row, "completed_at") }
      : {}),
    ...(optionalString(row, "failure_summary")
      ? { failureSummary: optionalString(row, "failure_summary") }
      : {}),
    ...(optionalString(row, "retry_of_attempt_id")
      ? { retryOfAttemptId: optionalString(row, "retry_of_attempt_id") }
      : {}),
  });

  readonly #mapJob = (row: SqlRow): JobIntent => ({
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    stageRunId: asString(row, "stage_run_id"),
    jobType: asString(row, "job_type") as SimulationJobType,
    payloadVersion: asNumber(row, "payload_version"),
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    status: asString(row, "status") as JobIntent["status"],
    idempotencyKey: asString(row, "idempotency_key"),
    availableAfter: asString(row, "available_after"),
    attemptCount: asNumber(row, "attempt_count"),
    ...(optionalString(row, "lease_owner")
      ? { leaseOwner: optionalString(row, "lease_owner") }
      : {}),
    ...(optionalString(row, "lease_expiration")
      ? { leaseExpiration: optionalString(row, "lease_expiration") }
      : {}),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    ...(row.completion_metadata_json
      ? {
          completionMetadata: parseJson<Record<string, unknown>>(row.completion_metadata_json),
        }
      : {}),
    ...(optionalString(row, "terminal_failure")
      ? { terminalFailure: optionalString(row, "terminal_failure") }
      : {}),
  });

  readonly #mapApproval = (row: SqlRow): Approval => ({
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    stageRunId: asString(row, "stage_run_id"),
    approvalType: "human_review",
    status: asString(row, "status") as Approval["status"],
    requestedAt: asString(row, "requested_at"),
    ...(optionalString(row, "resolved_at")
      ? { resolvedAt: optionalString(row, "resolved_at") }
      : {}),
    ...(optionalString(row, "resolved_by")
      ? { resolvedBy: optionalString(row, "resolved_by") }
      : {}),
    ...(optionalString(row, "rationale") ? { rationale: optionalString(row, "rationale") } : {}),
  });

  readonly #mapArtifact = (row: SqlRow): Artifact => ({
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    stageRunId: asString(row, "stage_run_id"),
    type: asString(row, "type"),
    name: asString(row, "name"),
    locationReference: asString(row, "location_reference"),
    digest: asString(row, "digest"),
    createdAt: asString(row, "created_at"),
  });

  readonly #mapEvent = (row: SqlRow): WorkflowEvent => ({
    cursor: asNumber(row, "cursor"),
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    eventType: asString(row, "event_type"),
    schemaVersion: asNumber(row, "schema_version"),
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    timestamp: asString(row, "timestamp"),
  });
}

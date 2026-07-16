// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- The synchronous SQLite engine injects its clock explicitly.
import * as NodeCrypto from "node:crypto";
import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";

import {
  type Approval,
  type ApprovalResolveRequest,
  type Artifact,
  type Attempt,
  type CommandExecutionCompletion,
  type CommandRun,
  type EventsListResult,
  type JobIntent,
  type JobType,
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
import { resolveSnapshotCommand } from "./commandResolution.ts";
import { WorkflowEngineError } from "./errors.ts";
import { migration001Sql } from "./migrations/001_initial.ts";
import { migration002Sql } from "./migrations/002_command_runs.ts";
import { ensurePrivateDirectory, ensurePrivateFile, openPrivateFile } from "./statePermissions.ts";

export const FACTORY_SCHEMA_VERSION = 2;
export const DEFAULT_LEASE_MILLISECONDS = 30_000;
export const MAX_LEASE_MILLISECONDS = 86_400_000;
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
interface WorkflowListCursor {
  readonly creationSequence: number;
}

const encodeWorkflowListCursor = (cursor: WorkflowListCursor): string =>
  NodeBuffer.Buffer.from(canonicalJson(cursor), "utf8").toString("base64url");

const decodeWorkflowListCursor = (cursor: string): WorkflowListCursor => {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("invalid base64url");
    const decoded = JSON.parse(
      NodeBuffer.Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      Object.keys(decoded).length !== 1 ||
      !("creationSequence" in decoded) ||
      !Number.isSafeInteger(decoded.creationSequence) ||
      Number(decoded.creationSequence) <= 0
    ) {
      throw new Error("invalid shape");
    }
    return { creationSequence: Number(decoded.creationSequence) };
  } catch {
    throw new WorkflowEngineError("invalid_cursor", "Workflow-list cursor is invalid.");
  }
};

const asString = (row: SqlRow, key: string): string => String(row[key]);
const asNumber = (row: SqlRow, key: string): number => Number(row[key]);
const optionalString = (row: SqlRow, key: string): string | undefined =>
  row[key] === null || row[key] === undefined ? undefined : String(row[key]);
const optionalNumber = (row: SqlRow, key: string): number | undefined =>
  row[key] === null || row[key] === undefined ? undefined : Number(row[key]);
const parseJson = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const terminalRunStatuses = new Set([
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "operator_attention",
]);
const terminalCommandStatuses = new Set([
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "terminated",
  "operator_attention",
]);

const stageSequence: ReadonlyArray<StageKey> = [
  "planning",
  "implementing",
  "validating",
  "human_review",
];

const jobTypeForStage = (stage: StageKey, validationCheckId?: string): JobType =>
  stage === "validating" && validationCheckId
    ? "command.execute"
    : stage === "validating"
      ? "simulation.request-human-review"
      : "simulation.complete-stage";

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
    if (options.stateDirectory.trim().length === 0) {
      throw new WorkflowEngineError(
        "invalid_request",
        "Factory state directory must not be empty.",
      );
    }
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
    const databaseHandle = await openPrivateFile(databasePath, true);
    if (!databaseHandle) {
      throw new WorkflowEngineError("internal_error", "Factory database could not be opened.");
    }
    let database: NodeSqlite.DatabaseSync;
    try {
      // Linux is the verified deployment target. Keeping this validated descriptor open while
      // SQLite opens /proc/self/fd closes the final-component symlink replacement window.
      const sqlitePath =
        NodeProcess.platform === "linux" ? `/proc/self/fd/${databaseHandle.fd}` : databasePath;
      database = new NodeSqlite.DatabaseSync(sqlitePath);
    } finally {
      await databaseHandle.close();
    }
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
          database.exec("PRAGMA user_version = 1;");
          database.exec("COMMIT;");
        } catch (cause) {
          database.exec("ROLLBACK;");
          throw cause;
        }
      }
      if (currentVersion < 2) {
        database.exec("BEGIN EXCLUSIVE;");
        try {
          database.exec(migration002Sql);
          database.exec("PRAGMA user_version = 2;");
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
             updated_at, project_snapshot_json, snapshot_digest, validation_check_id, version)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 1)`,
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
          input.validationCheckId ?? null,
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
        ...(input.validationCheckId ? { validationCheckId: input.validationCheckId } : {}),
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
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): WorkflowListResult {
    this.#assertOpen();
    const limit = input.limit ?? WorkflowListDefaultPageSize;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > WorkflowListMaximumPageSize) {
      throw new WorkflowEngineError("invalid_request", "Workflow-list page limit is invalid.");
    }
    const cursor = input.cursor === undefined ? undefined : decodeWorkflowListCursor(input.cursor);
    const rows = (
      cursor === undefined
        ? this.#database
            .prepare(
              `SELECT workflow_runs.*, workflow_runs.rowid AS creation_sequence
               FROM workflow_runs ORDER BY workflow_runs.rowid DESC LIMIT ?`,
            )
            .all(limit + 1)
        : this.#database
            .prepare(
              `SELECT workflow_runs.*, workflow_runs.rowid AS creation_sequence
               FROM workflow_runs
               WHERE workflow_runs.rowid < ?
               ORDER BY workflow_runs.rowid DESC LIMIT ?`,
            )
            .all(cursor.creationSequence, limit + 1)
    ) as ReadonlyArray<SqlRow>;
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const runs = pageRows.map(this.#mapWorkflowRun);
    const lastRow = pageRows.at(-1);
    return {
      runs,
      ...(hasMore && lastRow
        ? {
            nextCursor: encodeWorkflowListCursor({
              creationSequence: asNumber(lastRow, "creation_sequence"),
            }),
          }
        : {}),
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
    const commands = (
      this.#database
        .prepare("SELECT * FROM command_runs WHERE workflow_run_id = ? ORDER BY created_at, id")
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapCommandRun);
    return {
      workItem: this.#mapWorkItem(workItemRow),
      workflowRun,
      stages,
      attempts,
      jobs,
      approvals,
      artifacts,
      commands,
    };
  }

  readCommand(commandRunId: string): CommandRun {
    this.#assertOpen();
    return this.#findCommandRun(commandRunId);
  }

  claimNextJob(
    leaseOwner: string,
    leaseMilliseconds = DEFAULT_LEASE_MILLISECONDS,
  ): ClaimedJob | undefined {
    this.#assertOpen();
    if (
      leaseOwner.trim().length === 0 ||
      !Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds <= 0 ||
      leaseMilliseconds > MAX_LEASE_MILLISECONDS
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
      leaseMilliseconds <= 0 ||
      leaseMilliseconds > MAX_LEASE_MILLISECONDS
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
        if (nextStage === "validating" && run.validationCheckId) {
          this.#insertValidationCommand({
            id: this.#idGenerator(),
            run,
            stageId: nextStageId,
            commandId: run.validationCheckId,
            now,
          });
        }
        this.#insertJob({
          id: nextJobId,
          runId: run.id,
          stageId: nextStageId,
          stageKey: nextStage,
          ...(run.validationCheckId ? { validationCheckId: run.validationCheckId } : {}),
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
          jobType: jobTypeForStage(nextStage, run.validationCheckId),
        });
      }
      return this.readWorkflow(run.id);
    });
  }

  startCommand(input: {
    readonly commandRunId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly attemptId: string;
    readonly expectedStageVersion: number;
    readonly processHostExecutionId: string;
    readonly processHostType: string;
    readonly stdoutArtifactReference: string;
    readonly stderrArtifactReference: string;
  }): CommandRun {
    return this.#transaction(() => {
      const command = this.#findCommandRun(input.commandRunId);
      const job = this.#findJob(input.jobId);
      const now = this.#now();
      if (
        command.status !== "pending" ||
        job.status !== "claimed" ||
        job.workflowRunId !== command.workflowRunId ||
        job.stageRunId !== command.stageRunId ||
        job.leaseOwner !== input.leaseOwner ||
        job.leaseExpiration === undefined ||
        job.leaseExpiration <= now
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "The command cannot start without its current claimed execution job.",
        );
      }
      const stage = this.#findStage(command.stageRunId);
      const attempt = this.#findAttempt(input.attemptId);
      if (
        attempt.stageRunId !== stage.id ||
        attempt.attemptNumber !== stage.currentAttempt ||
        attempt.status !== "running"
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "The command attempt does not match the current claimed stage attempt.",
        );
      }
      if (stage.version !== input.expectedStageVersion) {
        throw new WorkflowEngineError("stale_version", "The command stage fence is stale.");
      }
      this.#database
        .prepare(
          `UPDATE command_runs
           SET status = 'starting', attempt_id = ?, process_host_execution_id = ?,
               process_host_type = ?, stdout_artifact_reference = ?,
               stderr_artifact_reference = ?, version = version + 1
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          input.attemptId,
          input.processHostExecutionId,
          input.processHostType,
          input.stdoutArtifactReference,
          input.stderrArtifactReference,
          command.id,
        );
      return this.#findCommandRun(command.id);
    });
  }

  markCommandRunning(input: {
    readonly commandRunId: string;
    readonly expectedVersion: number;
    readonly processHostExecutionId: string;
    readonly processHostType: string;
    readonly nativePid?: number;
    readonly startedAt: string;
    readonly timeoutDeadline: string;
    readonly workingDirectory: string;
  }): CommandRun {
    return this.#transaction(() => {
      const command = this.#findCommandRun(input.commandRunId);
      if (command.status !== "starting" || command.version !== input.expectedVersion) {
        throw new WorkflowEngineError(
          command.version !== input.expectedVersion ? "stale_version" : "invalid_transition",
          "The command is no longer awaiting process launch confirmation.",
        );
      }
      if (command.processHostExecutionId !== input.processHostExecutionId) {
        throw new WorkflowEngineError("conflict", "Process-host launch identity does not match.");
      }
      this.#database
        .prepare(
          `UPDATE command_runs
           SET status = 'running', process_host_type = ?, native_pid = ?, started_at = ?,
               timeout_deadline = ?, resolved_working_directory = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(
          input.processHostType,
          input.nativePid ?? null,
          input.startedAt,
          input.timeoutDeadline,
          input.workingDirectory,
          command.id,
        );
      this.#insertEvent(command.workflowRunId, "command.started", {
        commandRunId: command.id,
        processHostType: input.processHostType,
        processHostExecutionId: input.processHostExecutionId,
        timeoutDeadline: input.timeoutDeadline,
      });
      return this.#findCommandRun(command.id);
    });
  }

  completeCommand(input: {
    readonly commandRunId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly expectedCommandVersion: number;
    readonly expectedStageVersion: number;
    readonly result: CommandExecutionCompletion;
  }): WorkflowDetail {
    const completionDigest = digestJson(input.result);
    return this.#transaction(() => {
      const command = this.#findCommandRun(input.commandRunId);
      const run = this.#findWorkflowRun(command.workflowRunId);
      if (run.status === "cancelled" || command.status === "cancelled") {
        return this.readWorkflow(run.id);
      }
      if (command.outcome !== undefined && terminalCommandStatuses.has(command.status)) {
        const row = this.#database
          .prepare("SELECT completion_digest FROM command_runs WHERE id = ?")
          .get(command.id) as SqlRow | undefined;
        if (row && optionalString(row, "completion_digest") === completionDigest) {
          return this.readWorkflow(command.workflowRunId);
        }
        throw new WorkflowEngineError(
          "conflict",
          "Completed command replay does not match the original result.",
        );
      }
      const job = this.#findJob(input.jobId);
      const now = this.#now();
      if (
        job.status !== "claimed" ||
        job.leaseOwner !== input.leaseOwner ||
        job.leaseExpiration === undefined ||
        job.leaseExpiration <= now ||
        job.stageRunId !== command.stageRunId
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Only the current command-job lease owner may persist completion.",
        );
      }
      const stage = this.#findStage(command.stageRunId);
      if (stage.version !== input.expectedStageVersion) {
        throw new WorkflowEngineError("stale_version", "The command stage fence is stale.");
      }
      if (command.version !== input.expectedCommandVersion) {
        throw new WorkflowEngineError("stale_version", "The command completion fence is stale.");
      }
      if (
        command.processHostExecutionId !== input.result.executionId ||
        command.processHostType !== input.result.processHostType ||
        command.resolvedWorkingDirectory !== input.result.workingDirectory ||
        command.stdoutArtifactReference !== input.result.stdout.locationReference ||
        command.stderrArtifactReference !== input.result.stderr.locationReference ||
        (command.nativePid !== undefined && command.nativePid !== input.result.nativePid)
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Command completion does not match the recorded process execution.",
        );
      }
      if (!["starting", "running"].includes(command.status)) {
        throw new WorkflowEngineError(
          "invalid_transition",
          "The command is not in a completable state.",
        );
      }
      const failureClassification =
        input.result.outcome === "spawn_failed"
          ? "spawn_failed"
          : input.result.outcome === "timed_out"
            ? "timeout"
            : input.result.outcome === "terminated"
              ? "signal"
              : input.result.outcome === "failed"
                ? "nonzero_exit"
                : undefined;
      this.#database
        .prepare(
          `UPDATE command_runs
           SET status = ?, completed_at = ?, started_at = COALESCE(started_at, ?),
               timeout_deadline = COALESCE(timeout_deadline, ?), exit_code = ?,
               terminating_signal = ?, timed_out = ?, cancelled = ?,
               process_host_type = ?, process_host_execution_id = ?, native_pid = ?,
               resolved_working_directory = ?, stdout_artifact_reference = ?,
               stderr_artifact_reference = ?, stdout_digest = ?, stderr_digest = ?,
               stdout_observed_bytes = ?, stderr_observed_bytes = ?,
               stdout_persisted_bytes = ?, stderr_persisted_bytes = ?,
               stdout_truncated = ?, stderr_truncated = ?, redaction_metadata_json = ?,
               outcome = ?, failure_classification = ?, completion_digest = ?,
               version = version + 1
           WHERE id = ?`,
        )
        .run(
          input.result.outcome,
          input.result.completedAt,
          input.result.startedAt ?? null,
          input.result.timeoutDeadline ?? null,
          input.result.exitCode,
          input.result.signal,
          input.result.timedOut ? 1 : 0,
          input.result.cancelled ? 1 : 0,
          input.result.processHostType,
          input.result.executionId,
          input.result.nativePid ?? null,
          input.result.workingDirectory,
          input.result.stdout.locationReference,
          input.result.stderr.locationReference,
          input.result.stdout.digest,
          input.result.stderr.digest,
          input.result.stdout.observedBytes,
          input.result.stderr.observedBytes,
          input.result.stdout.persistedBytes,
          input.result.stderr.persistedBytes,
          input.result.stdout.truncated ? 1 : 0,
          input.result.stderr.truncated ? 1 : 0,
          canonicalJson({
            resolvedEnvironmentNames: input.result.resolvedEnvironmentNames,
            redactionCount: input.result.redactionCount,
          }),
          input.result.outcome,
          failureClassification ?? null,
          completionDigest,
          command.id,
        );
      this.#database
        .prepare(
          `UPDATE job_intents
           SET status = 'completed', lease_owner = NULL, lease_expiration = NULL,
               completion_metadata_json = ?, completion_owner = ?,
               completion_stage_version = ?, completion_digest = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          canonicalJson({ commandRunId: command.id, outcome: input.result.outcome }),
          input.leaseOwner,
          input.expectedStageVersion,
          completionDigest,
          now,
          job.id,
        );
      this.#database
        .prepare(
          `UPDATE attempts SET status = 'completed', completed_at = ?
           WHERE stage_run_id = ? AND attempt_number = ?`,
        )
        .run(now, stage.id, stage.currentAttempt);
      this.#database
        .prepare(
          `INSERT INTO artifacts
            (id, workflow_run_id, stage_run_id, type, name, location_reference, digest, created_at)
           VALUES (?, ?, ?, 'command_stdout', ?, ?, ?, ?),
                  (?, ?, ?, 'command_stderr', ?, ?, ?, ?)`,
        )
        .run(
          this.#idGenerator(),
          run.id,
          stage.id,
          `${command.commandId} stdout`,
          input.result.stdout.locationReference,
          input.result.stdout.digest,
          now,
          this.#idGenerator(),
          run.id,
          stage.id,
          `${command.commandId} stderr`,
          input.result.stderr.locationReference,
          input.result.stderr.digest,
          now,
        );
      if (input.result.stdout.observedBytes > 0 || input.result.stderr.observedBytes > 0) {
        this.#insertEvent(run.id, "command.output_available", {
          commandRunId: command.id,
          stdoutPersistedBytes: input.result.stdout.persistedBytes,
          stderrPersistedBytes: input.result.stderr.persistedBytes,
          stdoutTruncated: input.result.stdout.truncated,
          stderrTruncated: input.result.stderr.truncated,
        });
      }
      const requiresOperatorAttention = input.result.outcome === "operator_attention";
      const commandEvent =
        input.result.outcome === "passed"
          ? "command.completed"
          : input.result.outcome === "timed_out"
            ? "command.timed_out"
            : input.result.outcome === "cancelled"
              ? "command.cancelled"
              : requiresOperatorAttention
                ? "command.operator_attention_required"
                : "command.failed";
      this.#insertEvent(run.id, commandEvent, {
        commandRunId: command.id,
        outcome: input.result.outcome,
        exitCode: input.result.exitCode,
        signal: input.result.signal,
      });
      if (input.result.outcome !== "passed") {
        const terminalStatus = requiresOperatorAttention ? "operator_attention" : "failed";
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = ?, completed_at = ?, outcome = ?,
             failure_classification = ?, version = version + 1 WHERE id = ?`,
          )
          .run(
            terminalStatus,
            now,
            terminalStatus,
            failureClassification ?? input.result.outcome,
            stage.id,
          );
        this.#database
          .prepare(
            `UPDATE workflow_runs SET status = ?, terminal_outcome = ?,
             updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(terminalStatus, terminalStatus, now, run.id);
        this.#insertEvent(
          run.id,
          requiresOperatorAttention ? "workflow.operator_attention" : "workflow.failed",
          {
            commandRunId: command.id,
            outcome: input.result.outcome,
          },
        );
        return this.readWorkflow(run.id);
      }

      this.#database
        .prepare(
          `UPDATE stage_runs
           SET status = 'completed', completed_at = ?, outcome = 'succeeded', version = version + 1
           WHERE id = ?`,
        )
        .run(now, stage.id);
      this.#insertEvent(run.id, "stage.completed", {
        stageRunId: stage.id,
        stageKey: stage.stageKey,
      });
      const reviewStageId = this.#idGenerator();
      this.#insertStage({
        id: reviewStageId,
        runId: run.id,
        stageKey: "human_review",
        sequence: stage.sequence + 1,
        now,
      });
      const approvalId = this.#idGenerator();
      this.#database
        .prepare(
          `INSERT INTO approvals
            (id, workflow_run_id, stage_run_id, approval_type, status, requested_at)
           VALUES (?, ?, ?, 'human_review', 'pending', ?)`,
        )
        .run(approvalId, run.id, reviewStageId, now);
      this.#database
        .prepare(
          `UPDATE stage_runs SET status = 'waiting_approval', version = version + 1 WHERE id = ?`,
        )
        .run(reviewStageId);
      this.#database
        .prepare(
          `UPDATE workflow_runs SET status = 'human_review', updated_at = ?,
           version = version + 1 WHERE id = ?`,
        )
        .run(now, run.id);
      this.#insertEvent(run.id, "approval.requested", {
        approvalId,
        stageRunId: reviewStageId,
        approvalType: "human_review",
      });
      return this.readWorkflow(run.id);
    });
  }

  failCommandBeforeLaunch(input: {
    readonly commandRunId: string;
    readonly jobId: string;
    readonly leaseOwner: string;
    readonly expectedCommandVersion: number;
    readonly expectedStageVersion: number;
    readonly failureClassification: string;
  }): WorkflowDetail {
    return this.#transaction(() => {
      const command = this.#findCommandRun(input.commandRunId);
      const job = this.#findJob(input.jobId);
      const stage = this.#findStage(command.stageRunId);
      const now = this.#now();
      if (
        command.status !== "starting" ||
        command.version !== input.expectedCommandVersion ||
        stage.version !== input.expectedStageVersion ||
        job.status !== "claimed" ||
        job.leaseOwner !== input.leaseOwner ||
        job.leaseExpiration === undefined ||
        job.leaseExpiration <= now ||
        job.workflowRunId !== command.workflowRunId ||
        job.stageRunId !== command.stageRunId
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Pre-launch command failure no longer owns the command fence.",
        );
      }
      this.#database
        .prepare(
          `UPDATE command_runs SET status = 'spawn_failed', outcome = 'spawn_failed',
           completed_at = ?, failure_classification = ?, version = version + 1 WHERE id = ?`,
        )
        .run(now, input.failureClassification, command.id);
      this.#database
        .prepare(
          `UPDATE job_intents SET status = 'completed', lease_owner = NULL,
           lease_expiration = NULL, completion_metadata_json = ?, completion_owner = ?,
           completion_stage_version = ?, completion_digest = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          canonicalJson({ commandRunId: command.id, outcome: "spawn_failed" }),
          input.leaseOwner,
          input.expectedStageVersion,
          digestJson({ commandRunId: command.id, failure: input.failureClassification }),
          now,
          job.id,
        );
      this.#database
        .prepare(
          `UPDATE attempts SET status = 'completed', completed_at = ?
           WHERE stage_run_id = ? AND attempt_number = ?`,
        )
        .run(now, stage.id, stage.currentAttempt);
      this.#database
        .prepare(
          `UPDATE stage_runs SET status = 'failed', completed_at = ?, outcome = 'failed',
           failure_classification = ?, version = version + 1 WHERE id = ?`,
        )
        .run(now, input.failureClassification, stage.id);
      this.#database
        .prepare(
          `UPDATE workflow_runs SET status = 'failed', terminal_outcome = 'failed',
           updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(now, command.workflowRunId);
      this.#insertEvent(command.workflowRunId, "command.failed", {
        commandRunId: command.id,
        outcome: "spawn_failed",
        failureClassification: input.failureClassification,
      });
      this.#insertEvent(command.workflowRunId, "workflow.failed", {
        commandRunId: command.id,
        outcome: "spawn_failed",
      });
      return this.readWorkflow(command.workflowRunId);
    });
  }

  recordCancelledCommandResult(
    commandRunId: string,
    result: CommandExecutionCompletion,
  ): CommandRun {
    const completionDigest = digestJson(result);
    return this.#transaction(() => {
      const command = this.#findCommandRun(commandRunId);
      if (command.status !== "cancelled" || result.outcome !== "cancelled") {
        throw new WorkflowEngineError(
          "invalid_transition",
          "Only a cancelled process result may enrich a cancelled CommandRun.",
        );
      }
      if (
        command.processHostExecutionId !== undefined &&
        command.processHostExecutionId !== result.executionId
      ) {
        throw new WorkflowEngineError(
          "conflict",
          "Cancelled process result does not match the recorded execution identity.",
        );
      }
      if (command.stdoutDigest !== undefined || command.stderrDigest !== undefined) {
        const row = this.#database
          .prepare("SELECT completion_digest FROM command_runs WHERE id = ?")
          .get(command.id) as SqlRow | undefined;
        if (row && optionalString(row, "completion_digest") === completionDigest) {
          return command;
        }
        throw new WorkflowEngineError(
          "conflict",
          "Cancelled command output was already recorded with different content.",
        );
      }
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE command_runs SET completed_at = ?, started_at = COALESCE(started_at, ?),
           timeout_deadline = COALESCE(timeout_deadline, ?), exit_code = ?,
           terminating_signal = ?, process_host_type = ?, process_host_execution_id = ?,
           native_pid = ?, resolved_working_directory = ?, stdout_artifact_reference = ?,
           stderr_artifact_reference = ?, stdout_digest = ?, stderr_digest = ?,
           stdout_observed_bytes = ?, stderr_observed_bytes = ?,
           stdout_persisted_bytes = ?, stderr_persisted_bytes = ?,
           stdout_truncated = ?, stderr_truncated = ?, redaction_metadata_json = ?,
           completion_digest = ?, version = version + 1 WHERE id = ?`,
        )
        .run(
          result.completedAt,
          result.startedAt ?? null,
          result.timeoutDeadline ?? null,
          result.exitCode,
          result.signal,
          result.processHostType,
          result.executionId,
          result.nativePid ?? null,
          result.workingDirectory,
          result.stdout.locationReference,
          result.stderr.locationReference,
          result.stdout.digest,
          result.stderr.digest,
          result.stdout.observedBytes,
          result.stderr.observedBytes,
          result.stdout.persistedBytes,
          result.stderr.persistedBytes,
          result.stdout.truncated ? 1 : 0,
          result.stderr.truncated ? 1 : 0,
          canonicalJson({
            resolvedEnvironmentNames: result.resolvedEnvironmentNames,
            redactionCount: result.redactionCount,
          }),
          completionDigest,
          command.id,
        );
      this.#database
        .prepare(
          `INSERT INTO artifacts
            (id, workflow_run_id, stage_run_id, type, name, location_reference, digest, created_at)
           VALUES (?, ?, ?, 'command_stdout', ?, ?, ?, ?),
                  (?, ?, ?, 'command_stderr', ?, ?, ?, ?)`,
        )
        .run(
          this.#idGenerator(),
          command.workflowRunId,
          command.stageRunId,
          `${command.commandId} stdout`,
          result.stdout.locationReference,
          result.stdout.digest,
          now,
          this.#idGenerator(),
          command.workflowRunId,
          command.stageRunId,
          `${command.commandId} stderr`,
          result.stderr.locationReference,
          result.stderr.digest,
          now,
        );
      if (result.stdout.observedBytes > 0 || result.stderr.observedBytes > 0) {
        this.#insertEvent(command.workflowRunId, "command.output_available", {
          commandRunId: command.id,
          stdoutPersistedBytes: result.stdout.persistedBytes,
          stderrPersistedBytes: result.stderr.persistedBytes,
          stdoutTruncated: result.stdout.truncated,
          stderrTruncated: result.stderr.truncated,
        });
      }
      return this.#findCommandRun(command.id);
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

      const uncertainCommands = this.#database
        .prepare(
          `SELECT * FROM command_runs
           WHERE status IN ('starting','running','cancelling') ORDER BY id`,
        )
        .all() as ReadonlyArray<SqlRow>;
      for (const row of uncertainCommands) {
        const command = this.#mapCommandRun(row);
        this.#database
          .prepare(
            `UPDATE command_runs SET status = 'operator_attention',
             outcome = 'operator_attention', completed_at = ?,
             failure_classification = 'local_process_reconciliation_unavailable',
             version = version + 1 WHERE id = ?`,
          )
          .run(now, command.id);
        this.#database
          .prepare(
            `UPDATE job_intents SET status = 'failed', terminal_failure = ?,
             lease_owner = NULL, lease_expiration = NULL, updated_at = ?
             WHERE stage_run_id = ? AND status IN ('pending','claimed')`,
          )
          .run(
            "Local process ownership could not be reconciled after restart.",
            now,
            command.stageRunId,
          );
        this.#database
          .prepare(
            `UPDATE attempts SET status = 'failed', completed_at = ?, failure_summary = ?
             WHERE stage_run_id = ? AND status = 'running'`,
          )
          .run(
            now,
            "Local process ownership could not be reconciled after restart.",
            command.stageRunId,
          );
        this.#database
          .prepare(
            `UPDATE stage_runs SET status = 'operator_attention', completed_at = ?,
             outcome = 'operator_attention',
             failure_classification = 'local_process_reconciliation_unavailable',
             version = version + 1 WHERE id = ?`,
          )
          .run(now, command.stageRunId);
        this.#database
          .prepare(
            `UPDATE workflow_runs SET status = 'operator_attention',
             terminal_outcome = 'operator_attention', updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(now, command.workflowRunId);
        this.#insertEvent(command.workflowRunId, "command.operator_attention_required", {
          commandRunId: command.id,
          reason: "local_process_reconciliation_unavailable",
        });
        operatorAttentionRuns += 1;
      }

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
        const run = this.#findWorkflowRun(stage.workflowRunId);
        if (stage.stageKey === "validating" && run.validationCheckId) {
          const existingCommand = this.#database
            .prepare("SELECT id FROM command_runs WHERE stage_run_id = ?")
            .get(stage.id);
          if (!existingCommand) {
            this.#insertValidationCommand({
              id: this.#idGenerator(),
              run,
              stageId: stage.id,
              commandId: run.validationCheckId,
              now,
            });
          }
        }
        this.#insertJob({
          id: this.#idGenerator(),
          runId: stage.workflowRunId,
          stageId: stage.id,
          stageKey: stage.stageKey,
          ...(run.validationCheckId ? { validationCheckId: run.validationCheckId } : {}),
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
    if (input.validationCheckId !== undefined) {
      resolveSnapshotCommand({
        projectSnapshot: input.projectSnapshot,
        category: "check",
        commandId: input.validationCheckId,
      });
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
    readonly validationCheckId?: string;
    readonly now: string;
  }): void {
    const jobType = jobTypeForStage(input.stageKey, input.validationCheckId);
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
        jobType,
        canonicalJson({
          stageKey: input.stageKey,
          ...(jobType === "command.execute"
            ? { commandCategory: "check", commandId: input.validationCheckId }
            : {}),
        }),
        `${input.runId}:${input.stageId}:${jobType}`,
        input.now,
        input.now,
        input.now,
      );
  }

  #insertValidationCommand(input: {
    readonly id: string;
    readonly run: WorkflowRun;
    readonly stageId: string;
    readonly commandId: string;
    readonly now: string;
  }): void {
    const command = resolveSnapshotCommand({
      projectSnapshot: input.run.projectSnapshot,
      category: "check",
      commandId: input.commandId,
    });
    this.#database
      .prepare(
        `INSERT INTO command_runs
          (id, workflow_run_id, stage_run_id, command_category, command_id,
           command_definition_json, execution_root, resolved_working_directory,
           executable, args_json, environment_reference_names_json, status,
           created_at, redaction_metadata_json, version)
         VALUES (?, ?, ?, 'check', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '{}', 1)`,
      )
      .run(
        input.id,
        input.run.id,
        input.stageId,
        input.commandId,
        canonicalJson(command),
        input.run.projectSnapshot.repository.root,
        command.resolvedWorkingDirectory,
        command.executable,
        canonicalJson(command.args),
        canonicalJson(command.environment.map((reference) => reference.name)),
        input.now,
      );
    this.#insertEvent(input.run.id, "command.scheduled", {
      commandRunId: input.id,
      stageRunId: input.stageId,
      commandCategory: "check",
      commandId: input.commandId,
    });
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
    const activeCommands = (
      this.#database
        .prepare(
          `SELECT * FROM command_runs
           WHERE workflow_run_id = ? AND status IN ('pending','starting','running','cancelling')`,
        )
        .all(runId) as ReadonlyArray<SqlRow>
    ).map(this.#mapCommandRun);
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
    this.#database
      .prepare(
        `UPDATE command_runs SET status = 'cancelled', completed_at = ?,
         cancelled = 1, outcome = 'cancelled', failure_classification = 'workflow_cancelled',
         version = version + 1
         WHERE workflow_run_id = ? AND status IN ('pending','starting','running','cancelling')`,
      )
      .run(now, runId);
    this.#insertEvent(runId, "workflow.cancelled", { requestedBy });
    for (const command of activeCommands) {
      if (
        command.status === "starting" ||
        command.status === "running" ||
        command.status === "cancelling"
      ) {
        this.#insertEvent(runId, "command.termination_requested", {
          commandRunId: command.id,
          requestedBy,
        });
      }
      this.#insertEvent(runId, "command.cancelled", {
        commandRunId: command.id,
        requestedBy,
      });
    }
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

  #findCommandRun(commandRunId: string): CommandRun {
    const row = this.#database
      .prepare("SELECT * FROM command_runs WHERE id = ?")
      .get(commandRunId) as SqlRow | undefined;
    if (!row) throw new WorkflowEngineError("not_found", "Command run was not found.");
    return this.#mapCommandRun(row);
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
    ...(optionalString(row, "validation_check_id")
      ? { validationCheckId: optionalString(row, "validation_check_id") }
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
    jobType: asString(row, "job_type") as JobType,
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

  readonly #mapCommandRun = (row: SqlRow): CommandRun => ({
    id: asString(row, "id"),
    workflowRunId: asString(row, "workflow_run_id"),
    stageRunId: asString(row, "stage_run_id"),
    ...(optionalString(row, "attempt_id") ? { attemptId: optionalString(row, "attempt_id") } : {}),
    commandCategory: asString(row, "command_category") as CommandRun["commandCategory"],
    commandId: asString(row, "command_id"),
    commandDefinition: parseJson<Record<string, unknown>>(row.command_definition_json),
    executionRoot: asString(row, "execution_root"),
    resolvedWorkingDirectory: asString(row, "resolved_working_directory"),
    executable: asString(row, "executable"),
    args: parseJson<ReadonlyArray<string>>(row.args_json),
    environmentReferenceNames: parseJson<ReadonlyArray<string>>(
      row.environment_reference_names_json,
    ),
    status: asString(row, "status") as CommandRun["status"],
    createdAt: asString(row, "created_at"),
    ...(optionalString(row, "started_at") ? { startedAt: optionalString(row, "started_at") } : {}),
    ...(optionalString(row, "completed_at")
      ? { completedAt: optionalString(row, "completed_at") }
      : {}),
    ...(optionalString(row, "timeout_deadline")
      ? { timeoutDeadline: optionalString(row, "timeout_deadline") }
      : {}),
    ...(row.exit_code === null || row.exit_code === undefined
      ? {}
      : { exitCode: optionalNumber(row, "exit_code") ?? null }),
    ...(row.terminating_signal === null || row.terminating_signal === undefined
      ? {}
      : { terminatingSignal: optionalString(row, "terminating_signal") ?? null }),
    timedOut: asNumber(row, "timed_out") === 1,
    cancelled: asNumber(row, "cancelled") === 1,
    ...(optionalString(row, "process_host_type")
      ? { processHostType: optionalString(row, "process_host_type") }
      : {}),
    ...(optionalString(row, "process_host_execution_id")
      ? { processHostExecutionId: optionalString(row, "process_host_execution_id") }
      : {}),
    ...(optionalNumber(row, "native_pid") === undefined
      ? {}
      : { nativePid: optionalNumber(row, "native_pid") }),
    ...(optionalString(row, "stdout_artifact_reference")
      ? { stdoutArtifactReference: optionalString(row, "stdout_artifact_reference") }
      : {}),
    ...(optionalString(row, "stderr_artifact_reference")
      ? { stderrArtifactReference: optionalString(row, "stderr_artifact_reference") }
      : {}),
    ...(optionalString(row, "stdout_digest")
      ? { stdoutDigest: optionalString(row, "stdout_digest") }
      : {}),
    ...(optionalString(row, "stderr_digest")
      ? { stderrDigest: optionalString(row, "stderr_digest") }
      : {}),
    stdoutObservedBytes: asNumber(row, "stdout_observed_bytes"),
    stderrObservedBytes: asNumber(row, "stderr_observed_bytes"),
    stdoutPersistedBytes: asNumber(row, "stdout_persisted_bytes"),
    stderrPersistedBytes: asNumber(row, "stderr_persisted_bytes"),
    stdoutTruncated: asNumber(row, "stdout_truncated") === 1,
    stderrTruncated: asNumber(row, "stderr_truncated") === 1,
    redactionMetadata: parseJson<Record<string, unknown>>(row.redaction_metadata_json),
    ...(optionalString(row, "outcome")
      ? { outcome: optionalString(row, "outcome") as CommandRun["outcome"] }
      : {}),
    ...(optionalString(row, "failure_classification")
      ? { failureClassification: optionalString(row, "failure_classification") }
      : {}),
    version: asNumber(row, "version"),
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

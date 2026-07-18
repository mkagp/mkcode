export const migration004Sql = `
  ALTER TABLE workflow_runs ADD COLUMN builder_request_json TEXT;

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
    stage_run_id TEXT NOT NULL UNIQUE REFERENCES stage_runs(id),
    attempt_id TEXT REFERENCES attempts(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    semantic_role TEXT NOT NULL,
    runtime_kind TEXT NOT NULL,
    runtime_configuration_json TEXT NOT NULL,
    task_envelope_version INTEGER NOT NULL,
    task_envelope_json TEXT NOT NULL,
    task_envelope_digest TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    cancellation_requested_at TEXT,
    runtime_session_id TEXT,
    runtime_thread_id TEXT,
    process_host_execution_id TEXT,
    native_pid INTEGER,
    runtime_event_cursor INTEGER NOT NULL DEFAULT 0,
    result_envelope_json TEXT,
    result_envelope_digest TEXT,
    completion_reason TEXT,
    failure_classification TEXT,
    operator_attention_reason TEXT,
    stdout_artifact_reference TEXT,
    stderr_artifact_reference TEXT,
    stdout_digest TEXT,
    stderr_digest TEXT,
    stdout_observed_bytes INTEGER NOT NULL DEFAULT 0,
    stderr_observed_bytes INTEGER NOT NULL DEFAULT 0,
    stdout_persisted_bytes INTEGER NOT NULL DEFAULT 0,
    stderr_persisted_bytes INTEGER NOT NULL DEFAULT 0,
    stdout_truncated INTEGER NOT NULL DEFAULT 0,
    stderr_truncated INTEGER NOT NULL DEFAULT 0,
    pre_git_evidence_json TEXT,
    post_git_evidence_json TEXT,
    policy_violations_json TEXT NOT NULL DEFAULT '[]',
    completion_digest TEXT,
    version INTEGER NOT NULL
  );

  CREATE INDEX agent_runs_recovery
    ON agent_runs(status, workflow_run_id);

  CREATE INDEX agent_runs_workspace
    ON agent_runs(workspace_id, created_at);
`;

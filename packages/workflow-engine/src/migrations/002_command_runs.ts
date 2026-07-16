export const migration002Sql = `
  ALTER TABLE workflow_runs ADD COLUMN validation_check_id TEXT;

  CREATE TABLE command_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    attempt_id TEXT REFERENCES attempts(id),
    command_category TEXT NOT NULL,
    command_id TEXT NOT NULL,
    command_definition_json TEXT NOT NULL,
    execution_root TEXT NOT NULL,
    resolved_working_directory TEXT NOT NULL,
    executable TEXT NOT NULL,
    args_json TEXT NOT NULL,
    environment_reference_names_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    timeout_deadline TEXT,
    exit_code INTEGER,
    terminating_signal TEXT,
    timed_out INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    process_host_type TEXT,
    process_host_execution_id TEXT,
    native_pid INTEGER,
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
    redaction_metadata_json TEXT NOT NULL DEFAULT '{}',
    outcome TEXT,
    failure_classification TEXT,
    completion_digest TEXT,
    version INTEGER NOT NULL,
    UNIQUE(stage_run_id)
  );

  CREATE INDEX command_runs_workflow_created
    ON command_runs(workflow_run_id, created_at, id);

  CREATE INDEX command_runs_recovery
    ON command_runs(status, workflow_run_id);
`;

export const migration001Sql = `
  CREATE TABLE work_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    external_reference_json TEXT
  );

  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    work_item_id TEXT NOT NULL REFERENCES work_items(id),
    project_id TEXT NOT NULL,
    workflow_type TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    project_snapshot_json TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    cancellation_requested_at TEXT,
    cancellation_requested_by TEXT,
    terminal_outcome TEXT,
    version INTEGER NOT NULL
  );

  CREATE TABLE stage_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    stage_key TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    status TEXT NOT NULL,
    current_attempt INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    outcome TEXT,
    failure_classification TEXT,
    version INTEGER NOT NULL,
    UNIQUE(workflow_run_id, sequence)
  );

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    failure_summary TEXT,
    retry_of_attempt_id TEXT REFERENCES attempts(id),
    UNIQUE(stage_run_id, attempt_number)
  );

  CREATE TABLE job_intents (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    job_type TEXT NOT NULL,
    payload_version INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    available_after TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expiration TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completion_metadata_json TEXT,
    completion_owner TEXT,
    completion_stage_version INTEGER,
    completion_digest TEXT,
    terminal_failure TEXT
  );

  CREATE INDEX job_intents_claimable
    ON job_intents(status, available_after, lease_expiration, created_at);

  CREATE TABLE idempotency_records (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    stored_result_reference TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope, key)
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    approval_type TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT,
    rationale TEXT,
    UNIQUE(stage_run_id, approval_type)
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    location_reference TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE workflow_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
    event_type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX workflow_events_run_cursor
    ON workflow_events(workflow_run_id, cursor);
`;

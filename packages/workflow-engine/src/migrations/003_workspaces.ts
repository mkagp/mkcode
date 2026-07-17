export const migration003Sql = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id),
    project_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    source_repository_path TEXT NOT NULL,
    canonical_source_repository_path TEXT,
    git_common_directory TEXT,
    requested_base_branch TEXT NOT NULL,
    resolved_base_reference TEXT,
    resolved_base_commit TEXT,
    base_resolved_at TEXT,
    generated_branch_name TEXT,
    worktree_path TEXT,
    canonical_worktree_path TEXT UNIQUE,
    configured_worktree_root TEXT NOT NULL,
    effective_worktree_root TEXT,
    ownership_claim_path TEXT,
    ownership_marker_path TEXT,
    ownership_marker_digest TEXT,
    creation_intent_at TEXT NOT NULL,
    creation_started_at TEXT,
    ready_at TEXT,
    retained_at TEXT,
    cleanup_requested_at TEXT,
    cleanup_completed_at TEXT,
    failure_classification TEXT,
    operator_attention_reason TEXT,
    git_metadata_state TEXT,
    current_observed_head TEXT,
    current_observed_branch TEXT,
    dirty_state_json TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(canonical_source_repository_path, generated_branch_name)
  );

  CREATE INDEX workspaces_reconciliation
    ON workspaces(status, updated_at, id);

  CREATE INDEX workspaces_project_status
    ON workspaces(project_id, status, created_at);
`;

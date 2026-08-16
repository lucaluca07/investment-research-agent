CREATE TABLE chats (
  id VARCHAR PRIMARY KEY,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE research_runs (
  id VARCHAR PRIMARY KEY,
  chat_id VARCHAR NOT NULL,
  pi_session_id VARCHAR NOT NULL,
  model VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE research_run_steps (
  id VARCHAR PRIMARY KEY,
  run_id VARCHAR NOT NULL,
  step_name VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','running','succeeded','failed','waiting_approval','cancelled')),
  idempotency_key VARCHAR NOT NULL,
  input_hash VARCHAR NOT NULL,
  pi_message_id VARCHAR,
  pi_tool_call_id VARCHAR,
  result_json JSON,
  error_json JSON,
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  UNIQUE(run_id, idempotency_key)
);

CREATE TABLE approval_requests (
  id VARCHAR PRIMARY KEY,
  step_id VARCHAR NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','approved','rejected')),
  actor VARCHAR,
  reason VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);

CREATE TABLE research_notes (
  id VARCHAR PRIMARY KEY,
  run_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE citations (
  id VARCHAR PRIMARY KEY,
  note_id VARCHAR,
  document_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  published_at TIMESTAMP,
  locator VARCHAR
);

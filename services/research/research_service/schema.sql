CREATE TABLE IF NOT EXISTS chats (
  id VARCHAR PRIMARY KEY,
  pi_session_id VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id VARCHAR PRIMARY KEY,
  chat_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  content VARCHAR NOT NULL,
  idempotency_key VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
  , UNIQUE(chat_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS chat_events (
  chat_id VARCHAR NOT NULL,
  event_id BIGINT NOT NULL,
  event_type VARCHAR NOT NULL,
  data_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chat_id, event_id),
  FOREIGN KEY (chat_id) REFERENCES chats(id)
);

CREATE TABLE IF NOT EXISTS research_runs (
  id VARCHAR PRIMARY KEY,
  chat_id VARCHAR NOT NULL,
  pi_session_id VARCHAR NOT NULL,
  model VARCHAR NOT NULL,
  idempotency_key VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
  error_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chat_id) REFERENCES chats(id)
  , UNIQUE(chat_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS research_run_steps (
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
  UNIQUE(run_id, idempotency_key),
  FOREIGN KEY (run_id) REFERENCES research_runs(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id VARCHAR PRIMARY KEY,
  step_id VARCHAR NOT NULL,
  payload_json JSON NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('pending','approved','rejected')),
  actor VARCHAR,
  reason VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  FOREIGN KEY (step_id) REFERENCES research_run_steps(id)
);

CREATE TABLE IF NOT EXISTS research_notes (
  id VARCHAR PRIMARY KEY,
  run_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES research_runs(id)
);

CREATE TABLE IF NOT EXISTS citations (
  id VARCHAR PRIMARY KEY,
  note_id VARCHAR,
  document_id VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  published_at TIMESTAMP,
  locator VARCHAR,
  FOREIGN KEY (note_id) REFERENCES research_notes(id)
);

-- AG-UI persistence. These tables are the write target for the new runtime.
CREATE TABLE IF NOT EXISTS agui_schema_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  schema_fingerprint VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agui_schema_metadata (id, schema_version, schema_fingerprint)
VALUES (1, 2, 'agui-persistence-v2')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS threads (
  id VARCHAR PRIMARY KEY,
  title VARCHAR NOT NULL DEFAULT '',
  title_source VARCHAR NOT NULL DEFAULT 'initial',
  title_locked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runs (
  id VARCHAR PRIMARY KEY,
  thread_id VARCHAR NOT NULL,
  idempotency_key VARCHAR NOT NULL,
  model VARCHAR,
  input_json JSON,
  input_hash VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'interrupted', 'failed', 'cancelled')
  ),
  resumed_from_run_id VARCHAR,
  resumed_from_step_id VARCHAR,
  error_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (resumed_from_run_id, thread_id) REFERENCES runs(id, thread_id),
  UNIQUE(id, thread_id),
  UNIQUE(thread_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS agui_events (
  thread_id VARCHAR NOT NULL,
  sequence BIGINT NOT NULL,
  run_id VARCHAR,
  event_type VARCHAR NOT NULL,
  payload_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (thread_id, sequence),
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id)
);

CREATE TABLE IF NOT EXISTS message_snapshots (
  id VARCHAR PRIMARY KEY,
  thread_id VARCHAR NOT NULL,
  last_event_seq BIGINT NOT NULL,
  messages_json JSON NOT NULL,
  agent_state_json JSON NOT NULL,
  schema_version INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (thread_id, last_event_seq) REFERENCES agui_events(thread_id, sequence),
  UNIQUE(id, thread_id),
  UNIQUE(thread_id, last_event_seq)
);

CREATE TABLE IF NOT EXISTS tool_operations (
  id VARCHAR PRIMARY KEY,
  idempotency_key VARCHAR NOT NULL UNIQUE,
  thread_id VARCHAR NOT NULL,
  run_id VARCHAR NOT NULL,
  tool_name VARCHAR,
  input_json JSON,
  input_hash VARCHAR,
  status VARCHAR NOT NULL DEFAULT 'proposed' CHECK (
    status IN (
      'proposed', 'waiting_approval', 'approved', 'executing', 'succeeded', 'failed',
      'rejected', 'cancelled'
    )
  ),
  approval_id VARCHAR,
  result_json JSON,
  error_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id),
  UNIQUE(id, thread_id)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id VARCHAR PRIMARY KEY,
  thread_id VARCHAR NOT NULL,
  run_id VARCHAR NOT NULL,
  tool_operation_id VARCHAR,
  tool_name VARCHAR,
  arguments_json JSON,
  result_json JSON,
  step_status VARCHAR NOT NULL DEFAULT 'pending' CHECK (
    step_status IN (
      'pending', 'running', 'succeeded', 'failed', 'waiting_approval', 'interrupted',
      'cancelled'
    )
  ),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id),
  FOREIGN KEY (tool_operation_id, thread_id) REFERENCES tool_operations(id, thread_id),
  UNIQUE(id, thread_id)
);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
  id VARCHAR PRIMARY KEY,
  thread_id VARCHAR NOT NULL,
  run_id VARCHAR NOT NULL,
  tool_call_id VARCHAR,
  interrupt_id VARCHAR NOT NULL,
  pi_session_id VARCHAR,
  pi_message_id VARCHAR,
  last_event_seq BIGINT NOT NULL,
  agent_state_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (run_id, thread_id) REFERENCES runs(id, thread_id),
  FOREIGN KEY (tool_call_id, thread_id) REFERENCES tool_calls(id, thread_id),
  UNIQUE(id, thread_id),
  UNIQUE(thread_id, interrupt_id)
);

CREATE TABLE IF NOT EXISTS resume_receipts (
  id VARCHAR PRIMARY KEY,
  thread_id VARCHAR NOT NULL,
  interrupt_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL CHECK (status IN ('resolved', 'cancelled')),
  payload_hash VARCHAR NOT NULL,
  payload_json JSON NOT NULL,
  tool_operation_id VARCHAR,
  checkpoint_id VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES threads(id),
  FOREIGN KEY (tool_operation_id, thread_id) REFERENCES tool_operations(id, thread_id),
  FOREIGN KEY (checkpoint_id, thread_id) REFERENCES agent_checkpoints(id, thread_id),
  UNIQUE(thread_id, interrupt_id, status, payload_hash)
);

-- Legacy V1a tables remain readable until Task 9 removes their protocol path.
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

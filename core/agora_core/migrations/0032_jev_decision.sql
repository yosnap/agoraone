-- What Jev (TypeSafe) answered when AgoraOne asked it to decide something: only the checked answers, the model
-- version that gave them and the tokens, never the state that was sent (the text of a mail or a chat stays in its
-- own table). `applied` is 0 while Jev only shadows the current logic and 1 when its answer decided. Times UTC.

CREATE TABLE jev_decision (
  id INTEGER PRIMARY KEY,
  -- What was decided about (mail, chat, meeting, task, invoice, watson, vault, job), checked by the core.
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 20),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 60),
  -- JSON {question: {"type", "value", "confidence", "probabilities"}}.
  answers TEXT NOT NULL CHECK (json_valid(answers)),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 60),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX jev_decision_subject ON jev_decision (subject, subject_id);
CREATE INDEX jev_decision_created ON jev_decision (created_at);

-- 055_probe_library — learned third-party probe requests and the reply replayed for them.
-- status: candidate (learning) | active (replayed) | blocked (never replayed).
-- key_hashes: JSON array of short hashes of the API keys that sent it; no raw keys.

CREATE TABLE IF NOT EXISTS probe_library (
  fingerprint     TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'candidate',
  model_family    TEXT NOT NULL DEFAULT '',
  max_tokens      INTEGER NOT NULL DEFAULT 0,
  sample_text     TEXT NOT NULL DEFAULT '',
  key_hashes      TEXT NOT NULL DEFAULT '[]',
  distinct_keys   INTEGER NOT NULL DEFAULT 0,
  response_json   TEXT,
  bill_usage_json TEXT,
  response_at     TEXT,
  last_error      TEXT,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  dry_hit_count   INTEGER NOT NULL DEFAULT 0,
  upstream_count  INTEGER NOT NULL DEFAULT 0,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_probe_library_last_seen ON probe_library (last_seen);

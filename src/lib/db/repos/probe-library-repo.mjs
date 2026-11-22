/**
 * probe_library repository. The in-memory library (admin/probe-library.mjs) is the
 * hot path; this only loads it at boot and persists changed rows.
 */

import { getDb } from '../database.mjs'

const COLUMNS = [
  'fingerprint',
  'status',
  'model_family',
  'max_tokens',
  'sample_text',
  'key_hashes',
  'distinct_keys',
  'response_json',
  'bill_usage_json',
  'response_at',
  'last_error',
  'hit_count',
  'dry_hit_count',
  'upstream_count',
  'first_seen',
  'last_seen',
]

export class ProbeLibraryRepo {
  constructor(db = getDb()) {
    this.db = db
    this._all = db.prepare('SELECT * FROM probe_library ORDER BY last_seen DESC LIMIT ?')
    this._upsert = db.prepare(
      `INSERT INTO probe_library (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})
       ON CONFLICT(fingerprint) DO UPDATE SET ${COLUMNS.slice(1)
         .map((c) => `${c} = excluded.${c}`)
         .join(', ')}`,
    )
    this._del = db.prepare('DELETE FROM probe_library WHERE fingerprint = ?')
  }

  loadAll(limit = 100000) {
    return this._all.all(limit)
  }

  upsert(row) {
    this._upsert.run(...COLUMNS.map((c) => (row[c] === undefined ? null : row[c])))
  }

  remove(fingerprint) {
    this._del.run(fingerprint)
  }
}

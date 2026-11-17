import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../src/lib/db/database.mjs'

const MIGRATIONS = path.resolve(import.meta.dirname, '../../src/lib/db/migrations')
const OURS = '061_refusal_session_blocks.sql'

// Reproduce a deploy history: upstream migrations below `upTo`, then ours applied under `version`.
function legacyDb(dir, upTo, version) {
  const old = path.join(dir, 'old')
  fs.mkdirSync(old)
  for (const f of fs.readdirSync(MIGRATIONS)) {
    if (f < upTo && f !== OURS) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(old, f))
  }
  fs.copyFileSync(path.join(MIGRATIONS, OURS), path.join(old, `${version}_refusal_session_blocks.sql`))
  const db = new DatabaseSync(path.join(dir, 'kin.db'))
  applyMigrations(db, { migrationsDir: old })
  db.prepare(
    "INSERT INTO refusal_session_blocks (session_id, first_seen_at, last_seen_at) VALUES ('s-1234567', 'a', 'a')",
  ).run()
  return db
}

for (const [label, upTo, version, expected] of [
  ['1.4.121 (ours at 059)', '059_', '059', ['059_risk_audit_bans.sql', '060_crag_shop_order_dispatch.sql']],
  ['1.4.130 (ours at 060)', '060_', '060', ['060_crag_shop_order_dispatch.sql']],
]) {
  test(`a ${label} deploy DB moves refusal sessions to 061 and runs the upstream migrations`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mig-'))
    try {
      const db = legacyDb(dir, upTo, version)
      assert.deepEqual(applyMigrations(db), expected)
      const rows = db
        .prepare("SELECT version, name FROM schema_migrations WHERE version >= '059' ORDER BY version")
        .all()
      assert.deepEqual(
        rows.map((r) => [r.version, r.name]),
        [
          ['059', '059_risk_audit_bans.sql'],
          ['060', '060_crag_shop_order_dispatch.sql'],
          ['061', OURS],
        ],
      )
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refusal_session_blocks').get().n, 1)
      assert.deepEqual(applyMigrations(db), [])
      db.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

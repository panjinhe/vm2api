import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../../src/lib/db/database.mjs'

const MIGRATIONS = path.resolve(import.meta.dirname, '../../src/lib/db/migrations')

test('a deploy DB that applied refusal sessions as 059 moves it to 060 and runs upstream 059', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-mig-'))
  try {
    // Reproduce the 1.4.121 deploy history: everything up to 058, then our 059.
    const old = path.join(dir, 'old')
    fs.mkdirSync(old)
    for (const f of fs.readdirSync(MIGRATIONS)) {
      if (f < '059_') fs.copyFileSync(path.join(MIGRATIONS, f), path.join(old, f))
    }
    fs.copyFileSync(
      path.join(MIGRATIONS, '060_refusal_session_blocks.sql'),
      path.join(old, '059_refusal_session_blocks.sql'),
    )
    const db = new DatabaseSync(path.join(dir, 'kin.db'))
    applyMigrations(db, { migrationsDir: old })
    db.prepare("INSERT INTO refusal_session_blocks (session_id, first_seen_at, last_seen_at) VALUES ('s-1234567', 'a', 'a')").run()

    assert.deepEqual(applyMigrations(db), ['059_risk_audit_bans.sql'])
    const rows = db.prepare("SELECT version, name FROM schema_migrations WHERE version >= '059' ORDER BY version").all()
    assert.deepEqual(
      rows.map((r) => [r.version, r.name]),
      [
        ['059', '059_risk_audit_bans.sql'],
        ['060', '060_refusal_session_blocks.sql'],
      ],
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refusal_session_blocks').get().n, 1)
    assert.deepEqual(applyMigrations(db), [])
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

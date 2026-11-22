import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeHealthProbeConfig } from '../../src/lib/admin/health-probe.mjs'
import {
  createProbeLibrary,
  isProbeCandidate,
  probeFingerprint,
  replayableMessage,
} from '../../src/lib/admin/probe-library.mjs'

const cfg = normalizeHealthProbeConfig({ library: { enabled: true } })
const ua = { 'user-agent': 'new-api/0.9' }
const probe = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 5,
  messages: [{ role: 'user', content: 'Say OK' }],
}
const reply = {
  id: 'msg_up_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5-20250929',
  content: [{ type: 'text', text: 'OK' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
}

function makeLib(overrides = {}, clock = { t: 1_700_000_000_000 }) {
  const config = normalizeHealthProbeConfig({
    library: { enabled: true, ...overrides },
  })
  return { lib: createProbeLibrary({ config, now: () => clock.t }), clock }
}

function teach(lib, keys = ['k1', 'k2', 'k3'], body = probe) {
  const fp = probeFingerprint(body)
  for (const keyId of keys) {
    lib.observe(fp, {
      keyId,
      ok: true,
      body: reply,
      billUsage: { input_tokens: 900, output_tokens: 2 },
      sample: body,
    })
  }
  return fp
}

const look = (lib, body = probe, protocol = 'anthropic.messages') => lib.lookup({ headers: ua, body, protocol })

test('library config ships off and normalizes', () => {
  const off = normalizeHealthProbeConfig({})
  assert.equal(off.library.enabled, false)
  assert.equal(off.library.promote_min_keys, 3)
  const c = normalizeHealthProbeConfig({
    library: {
      enabled: 'on',
      ttl_sec: 100,
      refresh_sec: 999,
      max_system_chars: -1,
    },
  })
  assert.equal(c.library.enabled, true)
  assert.equal(c.library.refresh_sec, 100, 'refresh never exceeds ttl')
  assert.equal(c.library.max_system_chars, 0)
})

test('candidate: short single-turn text without tools', () => {
  const is = (body, protocol = 'anthropic.messages') => isProbeCandidate(ua, body, cfg, protocol)
  assert.equal(is(probe), true)
  assert.equal(is({ ...probe, max_tokens: 500 }), false)
  assert.equal(is({ ...probe, tools: [{ name: 'x' }] }), false)
  assert.equal(is({ ...probe, system: 'be nice' }), false)
  assert.equal(is({ ...probe, messages: [{ role: 'user', content: 'x'.repeat(65) }] }), false)
  assert.equal(
    is({
      ...probe,
      messages: [...probe.messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'again' }],
    }),
    false,
  )
  assert.equal(
    is({
      ...probe,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: 'hi' },
          ],
        },
      ],
    }),
    false,
  )
  assert.equal(is({ ...probe, thinking: { type: 'enabled', budget_tokens: 1024 } }), false)
  assert.equal(
    is(
      {
        ...probe,
        messages: [{ role: 'system', content: 'x' }, ...probe.messages],
      },
      'openai.chat',
    ),
    false,
    'chat system turns count against max_system_chars',
  )
})

test('candidate: missing max_tokens only counts on OpenAI protocols', () => {
  const { max_tokens: _drop, ...noMax } = probe
  assert.equal(isProbeCandidate(ua, noMax, cfg, 'openai.chat'), true)
  assert.equal(isProbeCandidate(ua, noMax, cfg, 'anthropic.messages'), false)
})

test('candidate: official Claude Code UA and the real-probe bypass header are skipped', () => {
  assert.equal(
    isProbeCandidate({ 'user-agent': 'claude-cli/2.1.0 (external, cli)' }, probe, cfg, 'anthropic.messages'),
    false,
  )
  assert.equal(isProbeCandidate({ ...ua, 'x-kin-health-real': '1' }, probe, cfg, 'anthropic.messages'), false)
})

test('fingerprint ignores stream, temperature, metadata and date suffix; not prompt or max_tokens', () => {
  const fp = probeFingerprint(probe)
  assert.equal(
    probeFingerprint({
      ...probe,
      stream: true,
      temperature: 0,
      metadata: { user_id: 'u' },
    }),
    fp,
  )
  assert.equal(probeFingerprint({ ...probe, model: 'claude-sonnet-4-5' }), fp)
  assert.equal(
    probeFingerprint({
      ...probe,
      messages: [{ role: 'user', content: '  say ok. ' }],
    }),
    fp,
  )
  assert.notEqual(probeFingerprint({ ...probe, max_tokens: 6 }), fp)
  assert.notEqual(
    probeFingerprint({
      ...probe,
      messages: [{ role: 'user', content: 'Say NO' }],
    }),
    fp,
  )
  assert.notEqual(probeFingerprint({ ...probe, model: 'claude-opus-4-1' }), fp)
})

test('replayableMessage rejects tool use and errors', () => {
  assert.ok(replayableMessage(reply))
  assert.equal(
    replayableMessage({
      ...reply,
      content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }],
    }),
    null,
  )
  assert.equal(replayableMessage({ type: 'error', error: {} }), null)
  assert.equal(replayableMessage({ ...reply, id: '' }), null)
  assert.equal(replayableMessage({ ...reply, stop_reason: 'refusal' }), null)
})

test('promotes only after enough distinct keys, then replays with billed usage', () => {
  const { lib } = makeLib()
  const fp = probeFingerprint(probe)
  assert.deepEqual(look(lib), { action: 'learn', fingerprint: fp })
  teach(lib, ['k1', 'k1', 'k2'])
  assert.equal(lib.get(fp).status, 'candidate', 'the same key twice counts once')
  assert.equal(look(lib).action, 'learn')
  teach(lib, ['k3'])
  assert.equal(lib.get(fp).status, 'active')
  const hit = look(lib, { ...probe, stream: true }, 'openai.chat')
  assert.equal(hit.action, 'replay')
  assert.equal(hit.message.id, 'msg_up_1')
  assert.deepEqual(hit.billUsage, { input_tokens: 900, output_tokens: 2 })
  assert.equal(lib.stats().hits, 1)
})

test('failed or unreplayable upstream calls never create an entry', () => {
  const { lib } = makeLib({ promote_min_keys: 1 })
  const fp = probeFingerprint(probe)
  assert.equal(lib.observe(fp, { keyId: 'k1', ok: false, error: 'boom', sample: probe }), null)
  assert.equal(lib.get(fp), null)
  lib.observe(fp, {
    keyId: 'k1',
    ok: true,
    body: { ...reply, content: [{ type: 'tool_use' }] },
    sample: probe,
  })
  assert.equal(lib.get(fp).status, 'candidate')
  assert.equal(lib.get(fp).response, null)
  assert.equal(look(lib).action, 'learn')
})

test('blocked entries pass straight through; disabled library does nothing', () => {
  const { lib } = makeLib({ promote_min_keys: 1 })
  const fp = teach(lib, ['k1'])
  assert.equal(lib.act(fp, 'block').ok, true)
  assert.deepEqual(look(lib), { action: 'pass' })
  assert.equal(lib.act(fp, 'activate').ok, true)
  assert.equal(look(lib).action, 'replay')
  lib.setConfig(normalizeHealthProbeConfig({ library: { enabled: false } }))
  assert.deepEqual(look(lib), { action: 'pass' })
  assert.equal(lib.act('nope', 'block').code, 'not_found')
  assert.equal(lib.act(fp, 'explode').code, 'invalid_action')
})

test('one request per refresh window goes upstream; expired replies stop replaying', () => {
  const { lib, clock } = makeLib({
    promote_min_keys: 1,
    refresh_sec: 60,
    ttl_sec: 600,
  })
  const fp = teach(lib, ['k1'])
  assert.equal(look(lib).action, 'replay')
  clock.t += 61_000
  assert.equal(look(lib).action, 'learn', 'first request after refresh_sec refreshes')
  assert.equal(look(lib).action, 'replay', 'others keep replaying while the refresh is in flight')
  lib.observe(fp, {
    keyId: 'k9',
    ok: false,
    error: 'upstream 529',
    sample: probe,
  })
  assert.equal(lib.get(fp).last_error, 'upstream 529')
  assert.equal(look(lib).action, 'learn', 'a failed refresh lets the next one retry')
  clock.t += 600_000
  assert.equal(look(lib).action, 'learn', 'past ttl every request goes upstream')
  assert.equal(look(lib).action, 'learn')
})

test('dry run learns and counts would-be hits but never replays', () => {
  const { lib } = makeLib({ promote_min_keys: 1, dry_run: true })
  const fp = teach(lib, ['k1'])
  assert.equal(look(lib).action, 'learn')
  assert.equal(lib.get(fp).dry_hit_count, 1)
  assert.equal(lib.get(fp).hit_count, 0)
})

test('persists through the repo and reloads', () => {
  const rows = new Map()
  const repo = {
    loadAll: () => [...rows.values()],
    upsert: (row) => rows.set(row.fingerprint, row),
    remove: (fp) => rows.delete(fp),
  }
  const config = normalizeHealthProbeConfig({
    library: { enabled: true, promote_min_keys: 1 },
  })
  const a = createProbeLibrary({ repo, config })
  const fp = teach(a, ['k1'])
  assert.equal(rows.get(fp).status, 'active')
  assert.equal(rows.get(fp).distinct_keys, 1)
  const b = createProbeLibrary({ repo, config })
  assert.equal(look(b).action, 'replay')
  b.act(fp, 'delete')
  assert.equal(rows.has(fp), false)
})

test('evicts the stalest non-active entry when full', () => {
  const clock = { t: 1_700_000_000_000 }
  const { lib } = makeLib({ max_entries: 10, promote_min_keys: 2 }, clock)
  const bodies = Array.from({ length: 11 }, (_, i) => ({
    ...probe,
    messages: [{ role: 'user', content: `ping ${i}` }],
  }))
  for (const body of bodies) {
    clock.t += 1000
    teach(lib, ['k1'], body)
  }
  assert.equal(lib.stats().entries, 10)
  assert.equal(lib.get(probeFingerprint(bodies[0])), null)
  assert.ok(lib.get(probeFingerprint(bodies[10])))
})

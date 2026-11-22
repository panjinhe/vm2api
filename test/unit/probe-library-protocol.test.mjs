import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { ThinkingOwnerStore } from '../../src/lib/pool/thinking-owner.mjs'
import { createHealthProbeMonitor, normalizeHealthProbeConfig } from '../../src/lib/admin/health-probe.mjs'
import { createProbeLibrary } from '../../src/lib/admin/probe-library.mjs'

const MODEL = 'claude-haiku-4-5'
const UPSTREAM = {
  id: 'msg_upstream_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-4-5-20251001',
  content: [{ type: 'text', text: 'OK' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 1 },
}

function fakeResponse() {
  const listeners = {}
  return {
    writes: [],
    headersSent: false,
    statusCode: 200,
    on(event, fn) {
      listeners[event] = fn
    },
    once() {},
    off() {},
    setHeader() {},
    writeHead(status) {
      this.statusCode = status
      this.headersSent = true
    },
    write(chunk) {
      this.writes.push(String(chunk))
      return true
    },
    end() {},
    finish() {
      listeners.finish?.()
    },
  }
}

function harness(library) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-probe-lib-'))
  const config = normalizeHealthProbeConfig({
    library: { enabled: true, ...library },
  })
  const probeLibrary = createProbeLibrary({ config })
  const monitor = createHealthProbeMonitor({ config, probeLibrary })
  const finished = []
  const charged = []
  const acquired = []
  let upstreamCalls = 0
  const handler = createHandleProtocol({
    json: (res, status, body) => {
      res.statusCode = status
      res.body = body
      return status
    },
    writeSSEHeaders(res) {
      res.headersSent = true
    },
    readBody: async (req) => req.body,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: {
        max_body_bytes: 1024 * 1024,
        upstream_timeout_ms: 5000,
        stream_idle_timeout_ms: 5000,
      },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({
        request_id: 'probe-lib',
        mode: 'summary',
        t0: Date.now(),
      }),
      finish: (_ctx, extra) => finished.push(extra),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      acquire: (rec) => {
        acquired.push(rec.id)
        return { ok: true }
      },
      release() {},
      recordUsage: (rec, usage) => charged.push({ id: rec.id, usage }),
    },
    apiScheduler: {},
    apiEndpointStore: {},
    stats: {
      errors: 0,
      requests: 0,
      by_route: {},
      passthrough: 0,
      rewrite: 0,
      convert: 0,
    },
    routingConfigPath: path.join(root, 'routing.json'),
    routingConfig: { compatibility: {}, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    thinkingOwners: new ThinkingOwnerStore({
      db: new DatabaseSync(':memory:'),
    }),
    getHealthMonitor: () => monitor,
    failoverRunner: {
      async run() {
        upstreamCalls++
        return {
          ok: true,
          status: 200,
          body: structuredClone(UPSTREAM),
          usage: UPSTREAM.usage,
          finalState: 'verified',
          attemptCount: 1,
          accountId: 'account-a',
          vmId: 'vm-01',
        }
      },
    },
  })
  const send = async (body, { protocol = 'anthropic.messages', key = 'key-1', ua = 'new-api/0.9' } = {}) => {
    const res = fakeResponse()
    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: { authorization: 'Bearer sk-x', 'user-agent': ua },
        apiKeyKind: 'managed',
        apiKeyRecord: { id: key, group_id: 1 },
        body,
        once() {},
        off() {},
      },
      res,
      protocol,
      '/v1/messages',
    )
    res.finish()
    return res
  }
  return {
    send,
    probeLibrary,
    finished,
    charged,
    acquired,
    get upstreamCalls() {
      return upstreamCalls
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

const probe = {
  model: MODEL,
  max_tokens: 5,
  messages: [{ role: 'user', content: 'Say OK' }],
}

test('learns from distinct keys, then replays in every protocol without an upstream call', async () => {
  const h = harness({ promote_min_keys: 2 })
  try {
    const a = await h.send(probe, { key: 'key-1' })
    assert.equal(a.statusCode, 200, JSON.stringify(a.body))
    await h.send(probe, { key: 'key-1' })
    assert.equal(h.upstreamCalls, 2, 'one key is not enough to promote')
    await h.send(probe, { key: 'key-2' })
    assert.equal(h.upstreamCalls, 3)

    const replay = await h.send({ ...probe, temperature: 0 }, { key: 'key-3' })
    assert.equal(h.upstreamCalls, 3, 'replay never reaches the failover runner')
    assert.equal(replay.statusCode, 200)
    assert.equal(replay.body.id, UPSTREAM.id)
    assert.equal(replay.body.model, MODEL, 'model echoes the request')
    assert.deepEqual(replay.body.content, UPSTREAM.content)
    const log = h.finished.at(-1)
    assert.equal(log.via, 'probe-cache')
    assert.equal(log.attempt_count, 0)
    assert.deepEqual(h.charged.at(-1), { id: 'key-3', usage: log.usage }, 'the replay is billed to the caller')
    assert.ok(log.usage.input_tokens > 0)
    assert.ok(h.acquired.includes('key-3'), 'the key gate still runs')

    const chat = await h.send(probe, { protocol: 'openai.chat' })
    assert.equal(chat.body.object, 'chat.completion')
    assert.equal(chat.body.choices[0].message.content, 'OK')

    const sse = await h.send({ ...probe, stream: true })
    assert.match(sse.writes.join(''), /event: message_stop/)
    const chatSse = await h.send({ ...probe, stream: true }, { protocol: 'openai.chat' })
    assert.match(chatSse.writes.join(''), /data: \[DONE\]/)
    const responses = await h.send(
      { model: MODEL, max_output_tokens: 5, input: 'Say OK' },
      { protocol: 'openai.responses' },
    )
    assert.equal(responses.body.object, 'response')
    assert.equal(h.upstreamCalls, 3)
    assert.equal(h.probeLibrary.stats().hits, 5)
  } finally {
    h.close()
  }
})

test('non-probe and official Claude Code requests always go upstream', async () => {
  const h = harness({ promote_min_keys: 1 })
  try {
    await h.send({ ...probe, max_tokens: 4096 })
    await h.send({ ...probe, max_tokens: 4096 })
    assert.equal(h.upstreamCalls, 2)
    await h.send(probe, { ua: 'claude-cli/2.1.304 (external, cli)' })
    await h.send(probe, { ua: 'claude-cli/2.1.304 (external, cli)' })
    assert.equal(h.upstreamCalls, 4)
    assert.equal(h.probeLibrary.stats().entries, 0)
  } finally {
    h.close()
  }
})

test('dry run keeps sending upstream', async () => {
  const h = harness({ promote_min_keys: 1, dry_run: true })
  try {
    await h.send(probe)
    await h.send(probe)
    await h.send(probe)
    assert.equal(h.upstreamCalls, 3)
    assert.equal(h.probeLibrary.stats().dry_hits, 2)
  } finally {
    h.close()
  }
})

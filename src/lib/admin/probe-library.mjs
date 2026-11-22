/**
 * Probe library: third-party "is it up?" requests (a tiny single-turn prompt, small
 * max_tokens, no tools) are fingerprinted by content. A fingerprint seen from enough
 * distinct API keys with a good upstream reply turns `active`, and later identical
 * requests replay that reply before any slot or seat is taken. The reply is refreshed
 * by letting one request through every `refresh_sec`; once `ttl_sec` passes without a
 * good refresh, requests go upstream again so a dead fleet is not masked.
 */
import crypto from 'node:crypto'
import { isOfficialClaudeUa } from '../identity/crs-headers.mjs'
import { isOfficialClaudeCodeTraffic } from '../identity/crs-persona.mjs'
import { enqueueWrite, writeBehindArmed } from '../db/write-behind.mjs'
import {
  DEFAULT_HEALTH_PROBE,
  blockText,
  extractProbeUserText,
  headerUa,
  inboundMaxTokens,
  isHealthRealBypass,
  normalizeModelId,
  normalizeProbeLibraryConfig,
  normalizeProbeText,
  systemText,
} from './health-probe.mjs'

export const PROBE_VIA_CACHE = 'probe-cache'
export const PROBE_STATUSES = Object.freeze(['candidate', 'active', 'blocked'])
const REFRESH_HOLD_MS = 120_000
const MAX_KEY_HASHES = 50
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text'])

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

function isOpenAiProtocol(protocol) {
  return protocol === 'openai.chat' || protocol === 'openai.responses' || protocol === 'openai.completions'
}

function inboundMaxOutput(body = {}) {
  const n = inboundMaxTokens(body) || Number(body?.max_output_tokens)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

/** Every non-system turn, in order: Messages, chat, and Responses `input` arrays. */
function conversationTurns(body = {}) {
  if (Array.isArray(body.messages)) return body.messages
  if (Array.isArray(body.input)) return body.input
  return null
}

function roleOf(turn) {
  return String(turn?.role || 'user').toLowerCase()
}

/** Text-only content: a probe never carries images, files or tool blocks. */
function isTextOnly(turn) {
  const content = turn?.content
  if (content == null || typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return content.every((b) => typeof b === 'string' || (b && TEXT_BLOCK_TYPES.has(String(b.type || 'text'))))
}

/** System text a request sends: Messages `system`, chat system/developer turns, Responses `instructions`. */
export function probeSystemText(body = {}) {
  const parts = [systemText(body?.system)]
  for (const turn of conversationTurns(body) || []) {
    const role = roleOf(turn)
    if (role === 'system' || role === 'developer') parts.push(blockText(turn).trim())
  }
  return parts.filter(Boolean).join('\n')
}

function modelFamily(model) {
  return normalizeModelId(model).replace(/-\d{8}$/, '')
}

/**
 * Probe-shaped: one short text user turn, small or (OpenAI only) missing max_tokens,
 * no tools, no thinking, no multi-choice. Official Claude Code traffic is skipped.
 */
export function isProbeCandidate(headers = {}, body = {}, cfg = DEFAULT_HEALTH_PROBE, protocol = '') {
  const lib = cfg?.library || DEFAULT_HEALTH_PROBE.library
  const match = cfg?.match || DEFAULT_HEALTH_PROBE.match
  if (!body || typeof body !== 'object') return false
  if (isHealthRealBypass(headers)) return false
  if (isOfficialClaudeCodeTraffic(headers, body)) return false
  if (match.skip_official !== false && isOfficialClaudeUa(headerUa(headers))) return false
  if (Array.isArray(body.tools) ? body.tools.length : body.tools) return false
  if (Array.isArray(body.functions) && body.functions.length) return false
  if (body.thinking && body.thinking.type && body.thinking.type !== 'disabled') return false
  if (Number(body.n) > 1) return false
  const max = inboundMaxOutput(body)
  if (max) {
    if (max > lib.max_tokens) return false
  } else if (!(isOpenAiProtocol(protocol) && match.allow_missing_max_tokens !== false)) {
    return false
  }
  if (probeSystemText(body).length > lib.max_system_chars) return false
  const turns = conversationTurns(body)
  if (turns) {
    const convo = turns.filter((t) => {
      const role = roleOf(t)
      return role !== 'system' && role !== 'developer'
    })
    if (convo.length !== 1 || !['user', 'input'].includes(roleOf(convo[0]))) return false
    if (!isTextOnly(convo[0])) return false
  }
  const { text } = extractProbeUserText(body)
  return !!text && text.length <= lib.max_prompt_chars
}

/**
 * Content fingerprint. Stream, temperature, metadata and ids are ignored, and the inbound
 * protocol too: the reply is re-rendered in the caller's protocol on replay.
 */
export function probeFingerprint(body = {}) {
  const parts = {
    m: modelFamily(body?.model),
    u: normalizeProbeText(extractProbeUserText(body).text).replace(/\s+/g, ' '),
    s: probeSystemText(body) ? sha(probeSystemText(body)).slice(0, 16) : '',
    t: inboundMaxOutput(body),
  }
  return sha(JSON.stringify(parts)).slice(0, 32)
}

/** The reply as clients saw it, reduced to what replay needs. Null when it is not replayable. */
export function replayableMessage(body) {
  if (!body || typeof body !== 'object' || body.type !== 'message') return null
  if (!String(body.id || '').trim()) return null
  const content = Array.isArray(body.content) ? body.content : []
  if (!content.length || !content.every((b) => b && (b.type === 'text' || b.type === 'thinking'))) return null
  if (body.stop_reason && !['end_turn', 'max_tokens', 'stop_sequence'].includes(body.stop_reason)) return null
  return {
    id: String(body.id).trim(),
    type: 'message',
    role: 'assistant',
    model: body.model || null,
    content,
    stop_reason: body.stop_reason || 'end_turn',
    stop_sequence: body.stop_sequence ?? null,
    usage: body.usage && typeof body.usage === 'object' ? body.usage : { input_tokens: 0, output_tokens: 0 },
  }
}

function parseJson(text, fallback) {
  if (text == null) return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

function rowToEntry(row) {
  return {
    fingerprint: row.fingerprint,
    status: PROBE_STATUSES.includes(row.status) ? row.status : 'candidate',
    model_family: row.model_family || '',
    max_tokens: Number(row.max_tokens) || 0,
    sample_text: row.sample_text || '',
    key_hashes: parseJson(row.key_hashes, []),
    response: parseJson(row.response_json, null),
    bill_usage: parseJson(row.bill_usage_json, null),
    response_at: row.response_at ? Date.parse(row.response_at) || 0 : 0,
    last_error: row.last_error || null,
    hit_count: Number(row.hit_count) || 0,
    dry_hit_count: Number(row.dry_hit_count) || 0,
    upstream_count: Number(row.upstream_count) || 0,
    first_seen: Date.parse(row.first_seen) || Date.now(),
    last_seen: Date.parse(row.last_seen) || Date.now(),
    refreshing_until: 0,
  }
}

function entryToRow(e) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null)
  return {
    fingerprint: e.fingerprint,
    status: e.status,
    model_family: e.model_family,
    max_tokens: e.max_tokens,
    sample_text: e.sample_text,
    key_hashes: JSON.stringify(e.key_hashes),
    distinct_keys: e.key_hashes.length,
    response_json: e.response ? JSON.stringify(e.response) : null,
    bill_usage_json: e.bill_usage ? JSON.stringify(e.bill_usage) : null,
    response_at: iso(e.response_at),
    last_error: e.last_error,
    hit_count: e.hit_count,
    dry_hit_count: e.dry_hit_count,
    upstream_count: e.upstream_count,
    first_seen: iso(e.first_seen),
    last_seen: iso(e.last_seen),
  }
}

export function viewEntry(e, cfg, now = Date.now()) {
  const age = e.response_at ? now - e.response_at : null
  return {
    fingerprint: e.fingerprint,
    status: e.status,
    model_family: e.model_family,
    max_tokens: e.max_tokens,
    sample_text: e.sample_text,
    distinct_keys: e.key_hashes.length,
    reply_text: (e.response?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
      .slice(0, 200),
    response_at: e.response_at ? new Date(e.response_at).toISOString() : null,
    fresh: age != null && age <= cfg.ttl_sec * 1000,
    last_error: e.last_error,
    hit_count: e.hit_count,
    dry_hit_count: e.dry_hit_count,
    upstream_count: e.upstream_count,
    first_seen: new Date(e.first_seen).toISOString(),
    last_seen: new Date(e.last_seen).toISOString(),
  }
}

/**
 * @param {{ repo?: { loadAll, upsert, remove } | null, config?: object, now?: () => number }} opts
 *   config is the whole health_probe block (library + match).
 */
export function createProbeLibrary(opts = {}) {
  const repo = opts.repo || null
  const nowFn = opts.now || (() => Date.now())
  let probeCfg = opts.config || DEFAULT_HEALTH_PROBE
  let cfg = normalizeProbeLibraryConfig(probeCfg.library)
  const entries = new Map()

  if (repo) {
    try {
      for (const row of repo.loadAll(cfg.max_entries)) entries.set(row.fingerprint, rowToEntry(row))
    } catch (e) {
      console.warn('[probe-library] load failed', e?.message || e)
    }
  }

  const persist = (entry) => {
    if (!repo) return
    const row = entryToRow(entry)
    const write = () => {
      try {
        repo.upsert(row)
      } catch (e) {
        console.warn('[probe-library] save failed', e?.message || e)
      }
    }
    if (writeBehindArmed()) enqueueWrite(write)
    else write()
  }

  const drop = (fingerprint) => {
    entries.delete(fingerprint)
    if (!repo) return
    try {
      repo.remove(fingerprint)
    } catch {}
  }

  /** Make room for a new candidate: evict the least recently seen non-active entry. */
  const evictIfFull = () => {
    if (entries.size < cfg.max_entries) return true
    let victim = null
    for (const e of entries.values()) {
      if (e.status === 'active') continue
      if (!victim || e.last_seen < victim.last_seen) victim = e
    }
    if (!victim) return false
    drop(victim.fingerprint)
    return true
  }

  const setConfig = (next) => {
    probeCfg = next || DEFAULT_HEALTH_PROBE
    cfg = normalizeProbeLibraryConfig(probeCfg.library)
    return cfg
  }

  /**
   * @returns {{ action: 'pass' } | { action: 'learn', fingerprint } | { action: 'replay', fingerprint, message, billUsage }}
   *   learn: go upstream, then call observe() with the outcome.
   */
  const lookup = ({ headers = {}, body = {}, protocol = '' } = {}) => {
    if (!cfg.enabled) return { action: 'pass' }
    if (!isProbeCandidate(headers, body, probeCfg, protocol)) return { action: 'pass' }
    const fingerprint = probeFingerprint(body)
    const entry = entries.get(fingerprint)
    if (!entry) return { action: 'learn', fingerprint }
    const now = nowFn()
    entry.last_seen = now
    if (entry.status === 'blocked') return { action: 'pass' }
    const age = entry.response ? now - entry.response_at : Infinity
    if (entry.status !== 'active' || age > cfg.ttl_sec * 1000) return { action: 'learn', fingerprint }
    // One request per refresh window goes upstream to keep the reply current and prove the fleet is up.
    if (age > cfg.refresh_sec * 1000 && !(entry.refreshing_until > now)) {
      entry.refreshing_until = now + REFRESH_HOLD_MS
      return { action: 'learn', fingerprint }
    }
    if (cfg.dry_run) {
      entry.dry_hit_count++
      persist(entry)
      return { action: 'learn', fingerprint }
    }
    entry.hit_count++
    persist(entry)
    return {
      action: 'replay',
      fingerprint,
      message: entry.response,
      billUsage: entry.bill_usage,
    }
  }

  /**
   * Record the upstream outcome of a learn request.
   * @param {{ keyId?: string, ok: boolean, body?: object, billUsage?: object, error?: string, sample?: object }} outcome
   */
  const observe = (
    fingerprint,
    { keyId = '', ok = false, body = null, billUsage = null, error = null, sample = {} } = {},
  ) => {
    if (!fingerprint || !cfg.enabled) return null
    const now = nowFn()
    let entry = entries.get(fingerprint)
    if (!entry) {
      if (!ok || !evictIfFull()) return null
      entry = {
        fingerprint,
        status: 'candidate',
        model_family: modelFamily(sample.model),
        max_tokens: inboundMaxOutput(sample),
        sample_text: extractProbeUserText(sample).text.slice(0, 200),
        key_hashes: [],
        response: null,
        bill_usage: null,
        response_at: 0,
        last_error: null,
        hit_count: 0,
        dry_hit_count: 0,
        upstream_count: 0,
        first_seen: now,
        last_seen: now,
        refreshing_until: 0,
      }
      entries.set(fingerprint, entry)
    }
    entry.last_seen = now
    entry.upstream_count++
    entry.refreshing_until = 0
    const message = ok ? replayableMessage(body) : null
    if (message) {
      entry.response = message
      entry.bill_usage = billUsage && typeof billUsage === 'object' ? billUsage : message.usage
      entry.response_at = now
      entry.last_error = null
      const keyHash = sha(`probe-key:${keyId || 'anonymous'}`).slice(0, 12)
      if (!entry.key_hashes.includes(keyHash) && entry.key_hashes.length < MAX_KEY_HASHES)
        entry.key_hashes.push(keyHash)
      if (entry.status === 'candidate' && entry.key_hashes.length >= cfg.promote_min_keys) entry.status = 'active'
    } else {
      entry.last_error = String(error || (ok ? 'reply not replayable' : 'upstream_error')).slice(0, 300)
    }
    persist(entry)
    return entry
  }

  const list = () => {
    const now = nowFn()
    return [...entries.values()].sort((a, b) => b.last_seen - a.last_seen).map((e) => viewEntry(e, cfg, now))
  }

  /** Panel action: block / activate / candidate / delete. */
  const act = (fingerprint, action) => {
    const entry = entries.get(fingerprint)
    if (!entry) return { ok: false, code: 'not_found' }
    if (action === 'delete') {
      drop(fingerprint)
      return { ok: true }
    }
    const status = {
      activate: 'active',
      block: 'blocked',
      candidate: 'candidate',
    }[action]
    if (!status) return { ok: false, code: 'invalid_action' }
    if (status === 'active' && !entry.response) return { ok: false, code: 'no_reply' }
    entry.status = status
    persist(entry)
    return { ok: true, entry: viewEntry(entry, cfg, nowFn()) }
  }

  const stats = () => {
    const out = {
      entries: entries.size,
      candidate: 0,
      active: 0,
      blocked: 0,
      hits: 0,
      dry_hits: 0,
      upstream: 0,
    }
    for (const e of entries.values()) {
      out[e.status]++
      out.hits += e.hit_count
      out.dry_hits += e.dry_hit_count
      out.upstream += e.upstream_count
    }
    return out
  }

  return {
    getConfig: () => cfg,
    setConfig,
    lookup,
    observe,
    list,
    act,
    stats,
    get: (fp) => entries.get(fp) || null,
  }
}

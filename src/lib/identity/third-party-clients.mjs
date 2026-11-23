/**
 * Known third-party agent clients: how to recognise them from what they write
 * into `system` / tool names, and how to neutralise their name in text that is
 * relocated out of `system`.
 *
 * Why this exists: some clients drive the official Claude Code CLI (or copy its
 * UA, billing block, user_id and identity line) and append their own prompt, so
 * they pass every official-traffic check and the third-party system relocation
 * never ran. Anthropic then answers 400 "Third-party apps now draw from your
 * extra usage". A hit here makes relocation run even for traffic that looks
 * official, and scrubs the client name from the relocated text.
 *
 * Detection reads only the client's own system text and tool names, never the
 * conversation, so a user who merely mentions a client by name is not matched.
 * OpenClaw and OpenCode markers were captured from production (2026-11-20/21);
 * the others come from the clients' published prompts.
 */
import { eachSystemText } from './crs-persona.mjs'

const TP = (id, label, { markers = [], toolPrefixes = [], names = [] }) =>
  Object.freeze({ id, label, markers, toolPrefixes, names })

export const THIRD_PARTY_CLIENTS = Object.freeze([
  TP('openclaw', 'OpenClaw', {
    markers: [
      /\brunning inside OpenClaw\b/i,
      /^## OpenClaw Control\b/m,
      /"schema"\s*:\s*"openclaw\.inbound_meta\./,
      /\bdocs\.openclaw\.ai\b/i,
    ],
    toolPrefixes: ['mcp__openclaw__'],
    names: [[/\bdocs\.openclaw\.ai\b/gi, 'the documentation site'], [/\bOpenClaw\b/gi, 'the agent']],
  }),
  TP('opencode', 'OpenCode', {
    markers: [/\bagent running in OpenCode\b/i, /\bopencode\.ai\b/i],
    names: [[/\bopencode\.ai\b/gi, 'the documentation site'], [/\bOpenCode\b/gi, 'the agent harness']],
  }),
  TP('cline', 'Cline', {
    markers: [/\bYou are Cline,/],
    names: [[/\bCline\b/g, 'the assistant']],
  }),
  TP('roo', 'Roo Code', {
    markers: [/\bYou are Roo,/, /\bRoo Code\b.*\bMode\b/s],
    names: [[/\bRoo Code\b/g, 'the assistant'], [/\bRoo\b/g, 'the assistant']],
  }),
  TP('kilo', 'Kilo Code', {
    markers: [/\bYou are Kilo Code,/],
    names: [[/\bKilo Code\b/g, 'the assistant']],
  }),
  TP('crush', 'Crush', {
    markers: [/\bYou are Crush,/],
    names: [[/\bCrush\b/g, 'the assistant']],
  }),
  TP('goose', 'goose', {
    markers: [/\bcalled goose\b/i, /\bcreated by Block\b.*\bgoose\b/is],
    names: [[/\bgoose\b/gi, 'the assistant']],
  }),
  // Seen in production claude-cli-UA traffic, 2026-11-18..21 (system block openings).
  TP('deepseek-harness', 'DeepSeek Harness', {
    markers: [/\bpowered by DeepSeek Harness\b/i],
    names: [[/\bDeepSeek Harness\b/gi, 'the agent harness']],
  }),
  TP('pi', 'pi', {
    markers: [/\brunning inside pi, a coding agent harness\b/i],
    names: [[/\binside pi, a coding agent harness\b/gi, 'inside a coding agent harness']],
  }),
  TP('codex', 'Codex', {
    markers: [/\bYou are Codex, a coding agent\b/, /# Codex desktop context/, /^<collaboration_mode>/m],
    names: [[/\bCodex\b/g, 'the assistant']],
  }),
  TP('copilot-cli', 'Copilot CLI', {
    markers: [/^Follow Microsoft content policies\./m],
    names: [],
  }),
  TP('cherry', 'Cherry Studio', {
    toolPrefixes: ['mcp__Cherry'],
    names: [[/\bCherry Studio\b/gi, 'the client']],
  }),
])

// Only the Anthropic `system` field: on the OpenAI-shaped path a system/developer
// turn is caller-written conversation content (upstream e6d74ea1, #1570).
function systemTexts(body) {
  return [...eachSystemText(body?.system)]
}

function toolNames(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.map((t) => t?.name ?? t?.function?.name).filter((n) => typeof n === 'string')
}

/** The known third-party client behind this request, or null. */
export function detectThirdPartyClient(body) {
  if (!body || typeof body !== 'object') return null
  const texts = systemTexts(body)
  const names = toolNames(body)
  for (const client of THIRD_PARTY_CLIENTS) {
    if (client.toolPrefixes.some((p) => names.some((n) => n.startsWith(p)))) return client
    if (client.markers.some((re) => texts.some((t) => re.test(t)))) return client
  }
  return null
}

/** Replace the client's name in free text. Tool names are never passed through here. */
export function scrubClientNames(text, client) {
  if (!client || typeof text !== 'string') return text
  let out = text
  for (const [re, replacement] of client.names) out = out.replace(re, replacement)
  return out
}

export const THIRD_PARTY_ACTIONS = Object.freeze(['off', 'relocate', 'block'])

const CLIENT_ID_SET = new Set(THIRD_PARTY_CLIENTS.map((client) => client.id))

export function isThirdPartyClientId(id) {
  return CLIENT_ID_SET.has(id)
}

/**
 * What to do with a detected client: routing.compatibility.third_party_clients.<id>
 * is off (forward as is) / relocate (system moved + name scrubbed) / block (403).
 * Unset falls back to the legacy blocked_clients switch (true => block), else relocate.
 */
export function thirdPartyActionFor(client, routing) {
  if (!client) return 'off'
  const compat = routing?.compatibility
  const value = compat?.third_party_clients?.[client.id]
  if (THIRD_PARTY_ACTIONS.includes(value)) return value
  return compat?.blocked_clients?.[client.id] === true ? 'block' : 'relocate'
}

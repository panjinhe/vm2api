import test from 'node:test'
import assert from 'node:assert/strict'
import { detectThirdPartyClient, scrubClientNames } from '../../src/lib/identity/third-party-clients.mjs'
import { relocateThirdPartySystem } from '../../src/lib/protocol/third-party-system.mjs'

const BILLING = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.321.403; cc_entrypoint=cli;' }
const IDENT = { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }

function spoofed(extra, tools = []) {
  return {
    model: 'claude-opus-5-5',
    system: [BILLING, IDENT, ...extra.map((text) => ({ type: 'text', text }))],
    tools: tools.map((name) => ({ name })),
    messages: [{ role: 'user', content: 'hello' }],
  }
}

test('detects OpenCode behind official billing block and identity line', () => {
  const body = spoofed(['You are an AI agent running in OpenCode, a coding agent harness.'], ['edit', 'glob'])
  assert.equal(detectThirdPartyClient(body)?.id, 'opencode')
})

test('detects OpenClaw by tool prefix and by system marker', () => {
  assert.equal(detectThirdPartyClient(spoofed(['x'], ['mcp__openclaw__send']))?.id, 'openclaw')
  assert.equal(detectThirdPartyClient(spoofed(['You are running inside OpenClaw.']))?.id, 'openclaw')
})

test('plain Claude Code and a user merely naming a client are not matched', () => {
  assert.equal(detectThirdPartyClient(spoofed(['You are an interactive agent that helps users.'], ['Bash'])), null)
  const body = spoofed([])
  body.messages = [{ role: 'user', content: 'compare OpenCode and Cline for me' }]
  assert.equal(detectThirdPartyClient(body), null)
})

test('relocation scrubs the client name in moved text only', () => {
  const body = spoofed(['You are an AI agent running in OpenCode, a coding agent harness. See opencode.ai.'])
  const client = detectThirdPartyClient(body)
  const r = relocateThirdPartySystem(body, { client })
  assert.equal(r.moved, true)
  const first = r.body.messages[0].content[0].text
  assert.doesNotMatch(first, /opencode/i)
  assert.match(first, /agent harness/)
  assert.equal(scrubClientNames('keep OpenCode', null), 'keep OpenCode')
})

test('without a client the relocated text is unchanged', () => {
  const body = spoofed(['custom agent text mentioning OpenCode'])
  const r = relocateThirdPartySystem(body)
  assert.match(r.body.messages[0].content[0].text, /OpenCode/)
})

test('detects clients seen in production traffic', () => {
  for (const [text, id] of [
    ['You are an AI agent powered by DeepSeek Harness. You are a coding agent', 'deepseek-harness'],
    ['You are a coding assistant running inside pi, a coding agent harness.', 'pi'],
    ['You are Codex, a coding agent. You and the user share the same workspace', 'codex'],
    ['You are Cline, an AI coding agent. Your primary goal', 'cline'],
    ['Follow Microsoft content policies. Avoid content that violates copyrights.', 'copilot-cli'],
  ]) assert.equal(detectThirdPartyClient(spoofed([text]))?.id, id)
  const r = relocateThirdPartySystem(spoofed(['a coding assistant running inside pi, a coding agent harness.']), { client: { names: [[/\binside pi, a coding agent harness\b/gi, 'inside a coding agent harness']] } })
  assert.doesNotMatch(r.body.messages[0].content[0].text, /inside pi/)
})

import { thirdPartyActionFor, detectThirdPartyClient as _detect } from '../../src/lib/identity/third-party-clients.mjs'
import { blockedClientFor } from '../../src/lib/identity/blocked-clients.mjs'

test('thirdPartyActionFor: new key wins, legacy blocked_clients maps to block, default relocate', () => {
  const oc = { id: 'openclaw' }
  assert.equal(thirdPartyActionFor(oc, {}), 'relocate')
  assert.equal(thirdPartyActionFor(oc, { compatibility: { blocked_clients: { openclaw: true } } }), 'block')
  assert.equal(
    thirdPartyActionFor(oc, { compatibility: { blocked_clients: { openclaw: true }, third_party_clients: { openclaw: 'off' } } }),
    'off',
  )
  assert.equal(thirdPartyActionFor(oc, { compatibility: { third_party_clients: { openclaw: 'bogus' } } }), 'relocate')
})

test('blockedClientFor only fires on block', () => {
  const body = { system: 'You are a personal assistant running inside OpenClaw.', messages: [] }
  assert.equal(blockedClientFor(body, { compatibility: { third_party_clients: { openclaw: 'relocate' } } }), null)
  assert.equal(blockedClientFor(body, { compatibility: { third_party_clients: { openclaw: 'block' } } })?.id, 'openclaw')
  assert.equal(blockedClientFor(body, { compatibility: { blocked_clients: { openclaw: true } } })?.id, 'openclaw')
})

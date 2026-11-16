/**
 * Project the tool results of the last user message into read-only context.
 *
 * CRAG claims a tool continuation by tool ID. When the results in the tail
 * must not claim it (an agent_summary fork observing its parent's results, or
 * a continuation the kernel already consumed or lost), the same content is
 * kept as labelled text and original blocks. Only the tail changes: every
 * earlier message keeps its bytes, so the cached prompt prefix still matches.
 */
export function readOnlyTailToolResults(messages) {
  if (!Array.isArray(messages)) return messages
  const index = messages.findLastIndex((message) => message?.role === 'user')
  const message = messages[index]
  if (!Array.isArray(message?.content) || !message.content.some((block) => block?.type === 'tool_result'))
    return messages
  const content = message.content.flatMap((block) => {
    if (block?.type !== 'tool_result') return [block]
    const label = { type: 'text', text: `[tool result ${block.tool_use_id}${block.is_error ? ' (error)' : ''}]` }
    if (block.cache_control) label.cache_control = block.cache_control
    const result = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] : block.content || []
    return [label, ...result]
  })
  const out = messages.slice()
  out[index] = { ...message, content }
  return out
}

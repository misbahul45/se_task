import { HumanMessage, AIMessage } from '@langchain/core/messages'

const MAX_ITERATIONS = 10

export function stripThinkBlocks(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

export function parseToolCall(text) {
  const match = text.match(/TOOL_CALL:\s*(\{[\s\S]*?\})(?:\n|$)/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}

export function stripToolCallLine(text) {
  return text.replace(/TOOL_CALL:\s*\{[\s\S]*?\}(?:\n|$)/, '').trim()
}

export async function runTool(tools, toolName, args) {
  const tool = tools.find(t => t.name === toolName)
  if (!tool) return { error: `Tool '${toolName}' tidak ditemukan` }
  try {
    const result = await tool.invoke(args)
    const parsed = typeof result === 'string' ? JSON.parse(result) : result
    if (parsed?.error) {
      console.error(`[runTool] Tool "${toolName}" returned error:`, parsed.error)
    }
    return parsed
  } catch (err) {
    console.error(`[runTool] Tool "${toolName}" threw exception:`, err.message)
    return { error: err.message, success: false }
  }
}

export async function executeReActLoop(
  llm,
  tools,
  systemPrompt,
  memoryManager,
  sessionId,
  userInput
) {
  const chatHistory = await memoryManager.getChatHistory(sessionId)
  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.map(m => ({
      role: m._getType() === 'human' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    })),
    { role: 'user', content: userInput }
  ]

  let finalOutput = ''
  let iterations = 0
  let currentMessages = [...messages]

  const toolCalls = []

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await llm.invoke(currentMessages)
    const responseText =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

    const cleanText = stripThinkBlocks(responseText)
    const toolCall = parseToolCall(cleanText)

    if (!toolCall) {
      finalOutput = cleanText
      break
    }

    console.log(`[ReAct] Iter ${iterations}: calling tool "${toolCall.tool}" with`, toolCall.args)

    const toolResult = await runTool(tools, toolCall.tool, toolCall.args)

    console.log(`[ReAct] Tool result:`, toolResult)

    toolCalls.push({
      tool: toolCall.tool,
      args: toolCall.args,
      result: toolResult
    })

    const assistantMsg = { role: 'assistant', content: cleanText }
    const toolResultMsg = {
      role: 'user',
      content: `TOOL_RESULT: ${JSON.stringify(toolResult)}\n\nLanjutkan berdasarkan hasil di atas.`
    }

    currentMessages = [...currentMessages, assistantMsg, toolResultMsg]
  }

  if (!finalOutput) {
    finalOutput = 'Maaf, saya tidak dapat memproses permintaan ini sekarang. 🙏'
  }

  await memoryManager.addMessage(sessionId, new HumanMessage(userInput))
  await memoryManager.addMessage(sessionId, new AIMessage({ content: finalOutput }))
  try {
    await memoryManager.saveLongTermMemory(sessionId, userInput, finalOutput)
  } catch (memErr) {
    console.warn('[ReAct] saveLongTermMemory failed (non-fatal):', memErr.message)
  }

  return { output: finalOutput, toolCalls }
}

export function handleRateLimit(error) {
  const isRateLimit =
    error?.status === 429 ||
    error?.message?.includes('429') ||
    error?.message?.includes('rate-limited')

  if (isRateLimit) {
    console.warn('[processMessage] Rate limit hit')
    return { output: 'Maaf, sistem sedang sibuk. Coba lagi sebentar ya 🙏', toolCalls: [] }
  }
  return null
}

export function handleError(error) {
  console.error('[processMessage Error]', error.message)
  return {
    output: 'Maaf, sistem sedang mengalami kendala. Silakan coba beberapa saat lagi 🙏',
    toolCalls: []
  }
}
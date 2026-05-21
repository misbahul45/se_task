import { HumanMessage, AIMessage } from '@langchain/core/messages'

const MAX_ITERATIONS = 6

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
    return typeof result === 'string' ? JSON.parse(result) : result
  } catch (err) {
    return { error: err.message }
  }
}

export async function executeReActLoop(llm, tools, systemPrompt, memoryManager, sessionId, userInput) {
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

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await llm.invoke(currentMessages)
    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)

    const toolCall = parseToolCall(responseText)

    if (!toolCall) {
      finalOutput = responseText
      break
    }

    console.log(`[ReAct] Iter ${iterations}: calling tool "${toolCall.tool}" with`, toolCall.args)

    const toolResult = await runTool(tools, toolCall.tool, toolCall.args)
    console.log(`[ReAct] Tool result:`, toolResult)

    const assistantMsg = { role: 'assistant', content: responseText }
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
  await memoryManager.saveLongTermMemory(sessionId, userInput, finalOutput)

  return { output: finalOutput }
}

export function handleRateLimit(error) {
  const isRateLimit = error?.status === 429
    || error?.message?.includes('429')
    || error?.message?.includes('rate-limited')

  if (isRateLimit) {
    console.warn('[processMessage] Rate limit hit')
    return { output: 'Maaf, sistem sedang sibuk. Coba lagi sebentar ya 🙏' }
  }
  return null
}

export function handleError(error) {
  console.error('[processMessage Error]', error.message)
  return { output: 'Maaf, sistem sedang mengalami kendala. Silakan coba beberapa saat lagi 🙏' }
}

import { ChatGroq } from '@langchain/groq'
import { createLokaReservationTools } from './sheet.js'
import { createMemoryTools } from './memory-tools.js'
import { MemoryManager } from './memory-manager.js'
import { loadSystemPrompt, buildReActSystemPrompt } from './prompts.js'
import { executeReActLoop, handleRateLimit, handleError } from './workflow.js'
import 'dotenv/config'

export async function createLokaAgent() {
  const llm = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.LLM_MODEL || 'llama-3.3-70b-versatile',
    temperature: 0.3,
    maxRetries: 3
  })

  const memoryManager = new MemoryManager()
  await memoryManager.initialize()

  const tools = [
    ...createLokaReservationTools(),
    ...createMemoryTools(memoryManager)
  ]

  const baseSystemPrompt = await loadSystemPrompt()
  const fullSystemPrompt = buildReActSystemPrompt(baseSystemPrompt, tools)

  return { llm, tools, memoryManager, systemPrompt: fullSystemPrompt }
}

function extractReservationData(rawOutput) {
  try {
    const toolCallMatch = rawOutput.match(/TOOL_CALL:\s*(\{[\s\S]*?\})\s*\n/)
    const toolResultMatch = rawOutput.match(/TOOL_RESULT:\s*(\{[\s\S]*?\})\s*\n/)

    if (!toolCallMatch || !toolResultMatch) return null

    const toolCall = JSON.parse(toolCallMatch[1])
    if (toolCall.tool !== 'loka_reservation_create') return null

    const toolResult = JSON.parse(toolResultMatch[1])

    return {
      ...toolCall.args,
      id: toolResult.id_reservasi ?? toolResult.id,
      status: toolResult.status,
      total: toolResult.total_belanja ?? toolResult.total,
      deposit: toolResult.deposit,
      sisa_pembayaran: toolResult.sisa_pembayaran,
      nama: toolCall.args.nama,
      whatsapp: toolCall.args.whatsapp,
      tanggal: toolCall.args.tanggal,
      jam: toolCall.args.jam,
      jumlah_orang: toolCall.args.tamu ?? toolCall.args.jumlah_orang,
      kategori: toolCall.args.area
    }
  } catch {
    return null
  }
}

function cleanOutput(rawOutput) {
  return rawOutput
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !trimmed.startsWith('TOOL_CALL:') && !trimmed.startsWith('TOOL_RESULT:')
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function processMessage(agentBundle, memoryManager, sessionId, userInput) {
  const { llm, tools, systemPrompt } = agentBundle

  try {
    const result = await executeReActLoop(llm, tools, systemPrompt, memoryManager, sessionId, userInput)

    if (result?.output) {
      const reservationData = extractReservationData(result.output)
      result.output = cleanOutput(result.output)
      if (reservationData) result.reservationData = reservationData
    }

    return result
  } catch (error) {
    console.log(error)
    return handleRateLimit(error) || handleError(error)
  }
}
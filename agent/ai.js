import { ChatOpenAI } from '@langchain/openai'
import { createLokaReservationTools } from './sheet.js'
import { createMemoryTools } from './memory-tools.js'
import { MemoryManager } from './memory-manager.js'
import { loadSystemPrompt, buildReActSystemPrompt } from './prompts.js'
import { executeReActLoop, handleRateLimit, handleError } from './workflow.js'
import 'dotenv/config'

export async function createLokaAgent() {
  const llm = new ChatOpenAI({
    apiKey: process.env.FLAZ_API_KEY,
    configuration: {
      baseURL: process.env.FLAZ_BASE_URL || 'https://ai.flaz.id/v1'
    },
    model: process.env.LLM_MODEL || 'MiniMax-M2.7-highspeed',
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

function extractReservationData(toolCalls = []) {
  try {
    const createCall = toolCalls.find(tc => tc.tool === 'loka_reservation_create')
    if (!createCall) return null

    const { args, result } = createCall

    if (!result?.success) return null

    const reservation = result.reservation ?? result.data ?? {}

    const id =
      reservation.id_reservasi ??
      reservation.id ??
      reservation.reservasi_id ??
      reservation.booking_id

    if (!id) {
      console.warn('[extractReservationData] Reservation created but no ID found in response', reservation)
      return null
    }

    return {
      id,
      nama: reservation.nama ?? args.nama,
      whatsapp: reservation.whatsapp ?? args.whatsapp,
      tanggal: reservation.tanggal ?? args.tanggal,
      jam: reservation.jam ?? args.jam,
      jumlah_orang: reservation.jumlah_orang ?? args.jumlah_orang,
      kategori: reservation.area ?? args.area,
      area: reservation.area ?? args.area,
      status: reservation.status,
      total: reservation.subtotal ?? reservation.total,
      deposit: reservation.deposit,
      sisa_pembayaran: reservation.sisa_pembayaran,
      room_charge: args.room_charge,
      extra_hour: args.extra_hour,
      catatan: args.catatan
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
      const reservationData = extractReservationData(result.toolCalls ?? [])
      result.output = cleanOutput(result.output)
      if (reservationData) result.reservationData = reservationData
    }

    return result
  } catch (error) {
    console.log(error)
    return handleRateLimit(error) || handleError(error)
  }
}
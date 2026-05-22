import { ChatOpenAI } from '@langchain/openai'
import { createLokaReservationTools } from './sheet.js'
import { createMemoryTools } from './memory-tools.js'
import { createDateTimeTools } from './datetime-tool.js'
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
    ...createDateTimeTools(),
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

    console.log('[extractReservationData] raw result:', JSON.stringify(result, null, 2))

    if (!result?.success) {
      console.warn('[extractReservationData] result.success is false:', result)
      return null
    }

    const reservation = result.reservation ?? result.data ?? {}

    console.log('[extractReservationData] reservation object keys:', Object.keys(reservation))

    // Cari ID dari semua kemungkinan field nama
    const id =
      reservation.id_reservasi ??
      reservation.id ??
      reservation.reservasi_id ??
      reservation.booking_id ??
      // Cari field apapun yang nilainya mirip format ID (LR-xxxx atau UUID)
      Object.values(reservation).find(v =>
        typeof v === 'string' && (
          /^LR-\d{4}-\d{2}-\d{5,}/.test(v) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
        )
      )

    if (!id) {
      console.warn('[extractReservationData] No ID found. Full reservation:', JSON.stringify(reservation))
      // Fallback: coba ambil field pertama yang terlihat seperti ID (string non-kosong, bukan angka murni)
      const fallbackId = Object.entries(reservation).find(([k, v]) =>
        typeof v === 'string' && v.length > 4 &&
        (k.toLowerCase().includes('id') || k.toLowerCase().includes('kode') || k.toLowerCase().includes('no'))
      )?.[1]
      if (!fallbackId) return null
      console.warn('[extractReservationData] Using fallback ID field:', fallbackId)
      return buildReservationResult(fallbackId, reservation, args)
    }

    return buildReservationResult(id, reservation, args)
  } catch (e) {
    console.error('[extractReservationData] exception:', e.message)
    return null
  }
}

function buildReservationResult(id, reservation, args) {
  return {
    id,
    nama: reservation.nama ?? args.nama,
    whatsapp: reservation.whatsapp ?? args.whatsapp,
    tanggal: reservation.tanggal ?? args.tanggal,
    jam: reservation.jam ?? args.jam,
    jumlah_orang: reservation.jumlah_orang ?? args.jumlah_orang,
    kategori: reservation.area ?? args.area,
    area: reservation.area ?? args.area,
    status: reservation.status ?? 'PENDING',
    total: reservation.subtotal ?? reservation.total ?? 0,
    deposit: reservation.deposit ?? 0,
    sisa_pembayaran: reservation.sisa_pembayaran ?? 0,
    room_charge: args.room_charge,
    extra_hour: args.extra_hour,
    catatan: args.catatan
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
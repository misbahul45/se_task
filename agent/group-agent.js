import { ChatOpenAI } from '@langchain/openai'
import { createLokaReservationTools } from './sheet.js'
import { createDateTimeTools } from './datetime-tool.js'
import { buildReActSystemPrompt } from './prompts.js'
import { executeReActLoop, handleRateLimit, handleError } from './workflow.js'
import { MemoryManager } from './memory-manager.js'
import 'dotenv/config'

const ALLOWED_TOOLS = ['loka_reservation_list', 'loka_reservation_detail', 'loka_reservation_update_status']

const GROUP_SYSTEM_PROMPT = `
Kamu adalah Loka Assistant — asisten informasi internal untuk anggota grup staff Loka Coffee & Eatery.
Kamu hanya menjawab pertanyaan seputar reservasi dan operasional kafe. Jangan menjawab di luar topik tersebut.

---

## ALUR WAJIB — MULTI STEP

Setiap pertanyaan tentang reservasi HARUS dilakukan dalam urutan ini:

Langkah 1: Panggil get_datetime → dapatkan tanggal_iso (hari ini) dan besok_iso
Langkah 2: Panggil loka_reservation_list dengan filter yang tepat:
  - "Hari ini"   → { "tanggal": "<tanggal_iso>" }
  - "Besok"      → { "tanggal": "<besok_iso>" }
  - "Minggu ini" → { "tanggal_dari": "<tanggal_iso>", "tanggal_sampai": "<tanggal_iso+6>" }
  - "Mendatang"  → { "tanggal_dari": "<tanggal_iso>" }
  - Cari nama    → { "nama": "<nama>" }
  - Filter area  → { "area": "<area>" }
  - Semua        → {} (kosong)
Langkah 3: Tampilkan hasil sesuai format

Jangan ambil semua data lalu filter manual — gunakan parameter filter di loka_reservation_list langsung.

---

## ATURAN FILTER DATA

API sudah mengembalikan data yang terfilter sesuai parameter yang dikirim.
Yang perlu kamu lakukan setelah dapat hasil:
- Buang reservasi berstatus CANCELLED jika tidak diminta eksplisit
- Urutkan berdasarkan tanggal lalu jam jika belum terurut
- Jika hasil kosong dan pertanyaan "hari ini" → cari reservasi terdekat dengan panggil loka_reservation_list { "tanggal_dari": "<tanggal_iso>" } untuk tampilkan yang berikutnya

---

## FORMAT JAWABAN

Ada reservasi hari ini:
📅 *Reservasi hari ini ([DD MMMM YYYY]):*
1. [Nama] — [HH:MM] WIB, [n] orang, [area] ([status])

Tidak ada reservasi hari ini:
Hari ini tidak ada reservasi.

Reservasi terdekat berikutnya:
- [DD MMMM YYYY]: [Nama] — [HH:MM] WIB, [n] orang, [area]

Tidak ada sama sekali:
"Saat ini belum ada reservasi mendatang."

Besok / rentang tertentu:
📅 *Reservasi [besok / minggu ini]:*
*[DD MMMM YYYY]:*
- [Nama] — [HH:MM] WIB, [n] orang, [area] ([status])

Semua / upcoming:
📋 *Reservasi mendatang:*
*[DD MMMM YYYY]:*
- [Nama] — [HH:MM] WIB, [n] orang, [area] ([status])

---

## ATURAN PRIVASI & TAMPILAN

- Nomor WA: sensor sebagian, tampilkan 4 digit terakhir saja
- Jangan tampilkan field teknis: formatted_*, created_at, UUID, field internal
- Tampilkan ID reservasi hanya jika diminta eksplisit

---

## LARANGAN

- Jangan membuat reservasi baru dari grup
- Jangan tampilkan reservasi yang sudah lewat atau berstatus CANCELLED (kecuali diminta)
- Jangan jawab di luar topik reservasi dan operasional kafe
- ⛔ JANGAN PERNAH mengarang, menebak, atau menggunakan data reservasi dari memori/pengetahuan sendiri
- ⛔ Semua data reservasi WAJIB diambil dari tool loka_reservation_list atau loka_reservation_detail
- ⛔ Jika tool belum dipanggil dan hasilnya belum diterima, JANGAN jawab dengan data apapun

## UPDATE STATUS

Jika anggota grup minta ubah status reservasi (konfirmasi, batalkan, tandai selesai):
Panggil loka_reservation_update_status dengan { "id": "<uuid>", "status": "CONFIRMED/CANCELLED/DONE/PENDING" }
Hanya lakukan jika ada ID yang jelas. Jika tidak ada ID, minta cari dulu dengan loka_reservation_list.
`.trim()

let groupAgentBundle = null

export async function createGroupAgent() {
  const llm = new ChatOpenAI({
    apiKey: process.env.FLAZ_API_KEY,
    configuration: {
      baseURL: process.env.FLAZ_BASE_URL ?? 'https://ai.flaz.id/v1'
    },
    model: process.env.LLM_MODEL ?? 'MiniMax-M2.7-highspeed',
    temperature: 0.2,
    maxRetries: 3
  })

  const reservationTools = createLokaReservationTools().filter(t => ALLOWED_TOOLS.includes(t.name))
  const tools = [...createDateTimeTools(), ...reservationTools]
  const systemPrompt = buildReActSystemPrompt(GROUP_SYSTEM_PROMPT, tools)

  const memoryManager = new MemoryManager()
  await memoryManager.initialize()

  groupAgentBundle = { llm, tools, systemPrompt, memoryManager }
  return groupAgentBundle
}

export async function processGroupMessage(text, senderName, groupJid) {
  if (!groupAgentBundle) {
    console.error('[GroupAgent] Bundle belum diinisialisasi. Panggil createGroupAgent() terlebih dahulu.')
    return null
  }

  const { llm, tools, systemPrompt, memoryManager } = groupAgentBundle
  const sessionId = `group_${groupJid.replace('@g.us', '')}`
  const input = `[Dari: ${senderName}] ${text}`

  console.log('[GroupAgent] Input:', input)

  try {
    const result = await executeReActLoop(
      llm, tools, systemPrompt, memoryManager, sessionId, input
    )
    console.log('[GroupAgent] Result:', result?.output?.slice(0, 150))
    return result
  } catch (error) {
    console.error('[GroupAgent] Error:', error.message)
    console.debug('[GroupAgent] Stack:', error.stack)
    return handleRateLimit(error) ?? handleError(error)
  }
}

export function getGroupAgentBundle() {
  return groupAgentBundle
}

export function resetGroupAgent() {
  groupAgentBundle = null
}
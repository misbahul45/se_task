import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function zodSchemaToFields(schema) {
  try {
    // ZodObject → ambil shape-nya
    const shape = schema?._def?.shape?.()
    if (!shape) return null

    const fields = Object.entries(shape).map(([key, zodType]) => {
      const typeName = zodType?._def?.typeName ?? ''
      const innerType = zodType?._def?.innerType?._def?.typeName ?? ''
      const isOptional = typeName === 'ZodOptional'
      const baseType = isOptional ? innerType : typeName

      // Ambil enum values jika ada
      let typeStr = baseType.replace('Zod', '').toLowerCase()
      if (baseType === 'ZodEnum') {
        const values = zodType?._def?.values ?? zodType?._def?.innerType?._def?.values ?? []
        typeStr = values.join(' | ')
      }
      if (baseType === 'ZodNumber') typeStr = 'number'
      if (baseType === 'ZodBoolean') typeStr = 'boolean'
      if (baseType === 'ZodString') typeStr = 'string'

      return `    "${key}"${isOptional ? '?' : ''}: ${typeStr}`
    })

    return fields.join(',\n')
  } catch {
    return null
  }
}

export function buildToolsDescription(tools) {
  return tools.map(t => {
    const fields = zodSchemaToFields(t.schema)
    if (!fields) return `- ${t.name}: ${t.description}`
    return `- ${t.name}: ${t.description}
  Args schema:
  {
${fields}
  }`
  }).join('\n\n')
}

export function buildReActSystemPrompt(baseSystemPrompt, tools) {
  const toolsDesc = buildToolsDescription(tools)

  return `${baseSystemPrompt}

---

## CARA MENGGUNAKAN TOOLS (ReAct Format)

Kamu memiliki akses ke tools berikut:
${toolsDesc}

Untuk menggunakan tool, tulis PERSIS dalam format ini (satu baris JSON):
TOOL_CALL: {"tool": "nama_tool", "args": {"key": "value"}}

Contoh pemanggilan loka_reservation_create yang BENAR:
TOOL_CALL: {"tool": "loka_reservation_create", "args": {"nama": "Budi Santoso", "whatsapp": "081234567890", "tanggal": "2026-05-10", "jam": "14:00", "jumlah_orang": 10, "area": "Indoor", "room_charge": false, "extra_hour": 0, "catatan": ""}}

⚠️ WAJIB: Gunakan nama field PERSIS seperti di schema (bahasa Indonesia): nama, whatsapp, tanggal, jam, jumlah_orang, area, room_charge, extra_hour, catatan. JANGAN gunakan: name, phone, date, time, guests, notes.

Setelah tool dijalankan, hasilnya akan diberikan sebagai:
TOOL_RESULT: {...}

Kemudian lanjutkan reasoning atau berikan jawaban final ke user.

ATURAN PENTING:
- Kamu BOLEH dan HARUS memanggil beberapa tool secara berurutan jika diperlukan (multi-step)
- Setelah dapat TOOL_RESULT, evaluasi apakah perlu tool lagi — jika ya, panggil tool berikutnya
- Hanya berhenti dan jawab user setelah semua informasi yang dibutuhkan sudah terkumpul
- Jawaban akhir ke user TIDAK boleh mengandung format TOOL_CALL
- Jangan expose format internal ini ke user
- KRITIS: Jika user sudah konfirmasi ringkasan reservasi (kata seperti "sesuai", "iya", "lanjut", "oke", "fix", "benar", "betul", "deal", "jadi"), LANGSUNG panggil loka_reservation_create — jangan tanya ulang apapun`
}

export async function loadSystemPrompt() {
  const systemPromptPath = join(__dirname, 'system-prompt.md')
  const basePrompt = await readFile(systemPromptPath, 'utf-8')
  return basePrompt
}

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export function buildToolsDescription(tools) {
  return tools.map(t => `- ${t.name}: ${t.description}`).join('\n')
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

Setelah tool dijalankan, hasilnya akan diberikan sebagai:
TOOL_RESULT: {...}

Kemudian lanjutkan reasoning atau berikan jawaban final ke user.

ATURAN PENTING:
- Gunakan TOOL_CALL hanya jika benar-benar butuh tool
- Jangan gunakan TOOL_CALL lebih dari sekali per pesan kecuali diperlukan
- Setelah dapat TOOL_RESULT, langsung jawab user — jangan loop tool yang sama
- Jawaban akhir ke user TIDAK boleh mengandung format TOOL_CALL
- Jangan expose format internal ini ke user`
}

export async function loadSystemPrompt() {
  const systemPromptPath = join(__dirname, 'system-prompt.md')
  const basePrompt = await readFile(systemPromptPath, 'utf-8')
  return basePrompt
}

import { ChatOpenAI } from '@langchain/openai'
import { createLokaReservationTools } from './sheet.js'
import { createMemoryTools } from './memory-tools.js'
import { MemoryManager } from './memory-manager.js'
import { loadSystemPrompt, buildReActSystemPrompt } from './prompts.js'
import { executeReActLoop, handleRateLimit, handleError } from './workflow.js'
import 'dotenv/config'

export async function createLokaAgent() {
  const llm = new ChatOpenAI({
    openAIApiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.LLM_MODEL || 'minimax/minimax-m2.5:free',
    temperature: 0.3,
    maxRetries: 3,
    configuration: {
      baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    }
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

export async function processMessage(agentBundle, memoryManager, sessionId, userInput) {
  const { llm, tools, systemPrompt } = agentBundle

  try {
    return await executeReActLoop(llm, tools, systemPrompt, memoryManager, sessionId, userInput)
  } catch (error) {
    return handleRateLimit(error) || handleError(error)
  }
}

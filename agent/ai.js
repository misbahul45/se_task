import { ChatGroq } from '@langchain/groq';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { createLokaReservationTools } from './sheet.js';
import { createMemoryTools } from './memory-tools.js';
import { MemoryManager } from './memory-manager.js';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GROQ_API_KEY = process.env.GROQ_API_KEY;


function escapePromptBraces(text) {
  const PLACEHOLDERS = ['input', 'chat_history', 'agent_scratchpad', 'steps'];
  return text.replace(/\{([^}]*)\}/g, (match, inner) => {
    if (PLACEHOLDERS.includes(inner.trim())) return match; // biarkan placeholder valid
    return match.replace(/\{/g, '{{').replace(/\}/g, '}}');
  });
}

// ─────────────────────────────────────────────
// Create agent
// ─────────────────────────────────────────────
export async function createLokaAgent() {
  const llm = new ChatGroq({
    apiKey: GROQ_API_KEY,
    model: 'llama-3.3-70b-versatile', 
    temperature: 0.3,
    maxRetries: 3,
  });

  const memoryManager = new MemoryManager();
  await memoryManager.initialize();

  const tools = [
    ...createLokaReservationTools(),
    ...createMemoryTools(memoryManager)
  ];

  // Baca & sanitasi system prompt
  const systemPromptPath = join(__dirname, 'system-prompt.md');
  let systemPrompt = await readFile(systemPromptPath, 'utf-8');
  systemPrompt = escapePromptBraces(systemPrompt);

  const prompt = ChatPromptTemplate.fromMessages([
    ['system', systemPrompt],
    new MessagesPlaceholder('chat_history'),
    ['human', '{input}'],
    ['placeholder', '{agent_scratchpad}']
  ]);

  const agent = createToolCallingAgent({ llm, tools, prompt });

  const agentExecutor = AgentExecutor.fromAgentAndTools({
    agent,
    tools,
    verbose: process.env.NODE_ENV !== 'production',
    handleParsingErrors: (err) => {
      console.error('[AgentParsingError]', err);
      return 'Maaf, terjadi kendala sementara dalam memproses permintaan. Boleh ulangi lagi? 🙏';
    },
    maxIterations: 6, 
  });

  return { agentExecutor, memoryManager };
}

export async function processMessage(agentExecutor, memoryManager, sessionId, userInput) {
  try {
    const chatHistory = await memoryManager.getChatHistory(sessionId);

    const result = await agentExecutor.invoke({
      input: userInput,
      chat_history: chatHistory
    });

    await memoryManager.addMessage(sessionId, new HumanMessage(userInput));
    await memoryManager.addMessage(sessionId, new AIMessage(result.output));
    await memoryManager.saveLongTermMemory(sessionId, userInput, result.output);

    return result;
  } catch (error) {
    console.error('[processMessage Error]', error);
    return {
      output: 'Maaf, sistem sedang mengalami kendala. Silakan coba beberapa saat lagi 🙏'
    };
  }
}
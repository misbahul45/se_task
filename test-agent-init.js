// test-agent-init.js
import { createLokaAgent } from './agent/ai.js'
import 'dotenv/config'

console.log('🧪 Testing createLokaAgent...')
console.log('OPENROUTER_API_KEY set:', !!process.env.OPENROUTER_API_KEY)

try {
  console.log('📦 Loading agent...')
  const { agentExecutor, memoryManager } = await createLokaAgent()
  
  console.log('✅ Success!')
  console.log('agentExecutor:', typeof agentExecutor)
  console.log('memoryManager:', typeof memoryManager)
  
  if (agentExecutor) {
    console.log('🔍 Agent methods:', Object.keys(agentExecutor).slice(0, 10))
  }
} catch (error) {
  console.error('💥 Error:', error.message)
  console.error('📋 Stack:', error.stack)
  console.error('🔍 Name:', error.name)
  console.error('🔍 Cause:', error.cause)
}
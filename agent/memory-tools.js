import { Tool } from '@langchain/core/tools';
import { z } from 'zod';

export class SaveMemoryTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'save_memory';
    this.description = 'Save important information to long-term memory. Use this when user shares preferences, personal info, or important facts. Input: sessionId, content to save, and optional category.';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID'),
      content: z.string().describe('Information to remember'),
      category: z.enum(['preference', 'personal', 'important', 'general']).optional().default('general').describe('Category of memory')
    });
  }

  async _call(input) {
    try {
      const { sessionId, content, category } = input;
      
      await this.memoryManager.saveLongTermMemory(
        sessionId,
        `[${category}] User shared: ${content}`,
        'User requested to save this information'
      );

      return JSON.stringify({
        success: true,
        message: 'Memory saved successfully',
        content: content,
        category: category
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      });
    }
  }
}

export class SearchMemoryTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'search_memory';
    this.description = 'Search long-term memory for relevant information. Use this to recall past conversations, preferences, or facts. Input: sessionId, search query, and optional number of results (default 5).';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID'),
      query: z.string().describe('What to search for'),
      k: z.number().int().min(1).max(20).optional().default(5).describe('Number of results')
    });
  }

  async _call(input) {
  try {
    const { sessionId, query, k } = input

    const memories = await this.memoryManager.searchMemories(query, sessionId, k)

    if (!memories || memories.length === 0) {
      return JSON.stringify({
        success: true,
        message: 'No relevant memories found',
        results: []
      })
    }

    const formattedResults = memories.map((m, idx) => ({
      index: idx + 1,
      content: m.content,
      score: Math.round(m.score * 100) / 100,
      timestamp: m.metadata?.timestamp
    }))

    return JSON.stringify({
      success: true,
      count: memories.length,
      results: formattedResults
    })
  } catch (error) {
    console.warn('[SearchMemory] Vector store not ready yet:', error.message)
    return JSON.stringify({
      success: true,
      message: 'No memories available yet',
      results: []
    })
  }
}
}

export class ForgetMemoryTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'forget_memory';
    this.description = 'Delete specific memories based on query. Use this when user wants to forget something. Input: sessionId, query to match memories, and optional similarity threshold (0-1, default 0.7).';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID'),
      query: z.string().describe('What memories to forget'),
      threshold: z.number().min(0).max(1).optional().default(0.7).describe('Similarity threshold')
    });
  }

  async _call(input) {
    try {
      const { sessionId, query, threshold } = input;
      
      const result = await this.memoryManager.deleteMemory(sessionId, query, threshold);

      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      });
    }
  }
}

export class GetAllMemoriesTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'get_all_memories';
    this.description = 'Get all stored memories for a user. Use this to review everything remembered about a user. Input: sessionId and optional limit (default 100).';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID'),
      limit: z.number().int().min(1).max(500).optional().default(100).describe('Maximum memories to retrieve')
    });
  }

  async _call(input) {
    try {
      const { sessionId, limit } = input;
      
      const memories = await this.memoryManager.getAllMemories(sessionId, limit);

      return JSON.stringify({
        success: true,
        count: memories.length,
        memories: memories
      });
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      });
    }
  }
}

export class MemoryStatsTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'memory_stats';
    this.description = 'Get statistics about memory storage for a user. Shows count of short-term and long-term memories.';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID')
    });
  }

  async _call(input) {
    try {
      const { sessionId } = input;
      
      const stats = await this.memoryManager.getMemoryStats(sessionId);

      return JSON.stringify(stats);
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      });
    }
  }
}

export class ClearAllMemoriesTool extends Tool {
  constructor(memoryManager) {
    super();
    this.memoryManager = memoryManager;
    this.name = 'clear_all_memories';
    this.description = 'WARNING: Delete ALL long-term memories for a user. Use only when explicitly requested by user. Input: sessionId.';
    this.schema = z.object({
      sessionId: z.string().describe('User session ID')
    });
  }

  async _call(input) {
    try {
      const { sessionId } = input;
      
      const result = await this.memoryManager.clearAllMemories(sessionId);

      return JSON.stringify(result);
    } catch (error) {
      return JSON.stringify({
        success: false,
        error: error.message
      });
    }
  }
}

export function createMemoryTools(memoryManager) {
  return [
    new SaveMemoryTool(memoryManager),
    new SearchMemoryTool(memoryManager),
    new ForgetMemoryTool(memoryManager),
    new GetAllMemoriesTool(memoryManager),
    new MemoryStatsTool(memoryManager),
    new ClearAllMemoriesTool(memoryManager)
  ];
}
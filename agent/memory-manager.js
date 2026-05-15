import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { Document } from '@langchain/core/documents';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { XenovaEmbeddings } from './xenova-embeddings.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class MemoryManager {
  constructor(params = {}) {
    const projectRoot = join(__dirname, '..');
    this.memoryStorePath = params.memoryStorePath || join(projectRoot, 'memory-store');
    this.shortTermMemoryPath = join(this.memoryStorePath, 'short-term');
    this.longTermMemoryPath = join(this.memoryStorePath, 'long-term');
    this.embeddings = new XenovaEmbeddings({ modelName: 'Xenova/all-MiniLM-L6-v2' });
    this.vectorStores = new Map();
    this.chatHistories = new Map();
    this.maxShortTermMessages = params.maxShortTermMessages || 50;
    this.autoSaveThreshold = params.autoSaveThreshold || 3;
  }

  async initialize() {
    if (!existsSync(this.memoryStorePath)) {
      mkdirSync(this.memoryStorePath, { recursive: true });
    }
    if (!existsSync(this.shortTermMemoryPath)) {
      mkdirSync(this.shortTermMemoryPath, { recursive: true });
    }
    if (!existsSync(this.longTermMemoryPath)) {
      mkdirSync(this.longTermMemoryPath, { recursive: true });
    }
  }

  getShortTermMemoryFile(sessionId) {
    return join(this.shortTermMemoryPath, `${sessionId}.json`);
  }

  getLongTermMemoryPath(sessionId) {
    return join(this.longTermMemoryPath, sessionId);
  }

  async loadChatHistory(sessionId) {
    const filePath = this.getShortTermMemoryFile(sessionId);
    if (existsSync(filePath)) {
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'));
        return data.map(msg => {
          if (msg.type === 'human') return new HumanMessage(msg.content);
          if (msg.type === 'ai') return new AIMessage(msg.content);
          return null;
        }).filter(Boolean);
      } catch (error) {
        return [];
      }
    }
    return [];
  }

  async saveChatHistory(sessionId, messages) {
    const filePath = this.getShortTermMemoryFile(sessionId);
    const serializedMessages = messages.slice(-this.maxShortTermMessages).map(msg => ({
      type: msg.constructor.name === 'HumanMessage' ? 'human' : 'ai',
      content: msg.content
    }));
    writeFileSync(filePath, JSON.stringify(serializedMessages, null, 2));
  }

  async addMessage(sessionId, message) {
    const history = await this.loadChatHistory(sessionId);
    history.push(message);
    await this.saveChatHistory(sessionId, history);
  }

  async getChatHistory(sessionId) {
    return await this.loadChatHistory(sessionId);
  }

  async clearChatHistory(sessionId) {
    const filePath = this.getShortTermMemoryFile(sessionId);
    if (existsSync(filePath)) {
      rmSync(filePath);
    }
    this.chatHistories.delete(sessionId);
  }

  async getOrCreateVectorStore(sessionId) {
    if (this.vectorStores.has(sessionId)) {
      return this.vectorStores.get(sessionId);
    }
    const storePath = this.getLongTermMemoryPath(sessionId);
    let vectorStore;
    if (existsSync(storePath)) {
      try {
        vectorStore = await FaissStore.load(storePath, this.embeddings);
      } catch (error) {
        vectorStore = await FaissStore.fromDocuments([], this.embeddings);
      }
    } else {
      vectorStore = await FaissStore.fromDocuments([], this.embeddings);
    }
    this.vectorStores.set(sessionId, vectorStore);
    return vectorStore;
  }

  async saveLongTermMemory(sessionId, userInput, aiResponse) {
    const vectorStore = await this.getOrCreateVectorStore(sessionId);
    const memoryContent = `User: ${userInput}\nAssistant: ${aiResponse}`;
    const metadata = {
      timestamp: new Date().toISOString(),
      userInput: userInput,
      aiResponse: aiResponse,
      sessionId: sessionId
    };
    const doc = new Document({
      pageContent: memoryContent,
      metadata: metadata
    });
    await vectorStore.addDocuments([doc]);
    await this.saveVectorStore(sessionId);
    const history = await this.loadChatHistory(sessionId);
    if (history.length >= this.autoSaveThreshold) {
      await this.autoExtractMemories(sessionId, history);
    }
  }

  async autoExtractMemories(sessionId, messages) {
    const lastMessages = messages.slice(-this.autoSaveThreshold);
    const combinedContent = lastMessages.map(m => m.content).join('\n');
    const importantKeywords = [
      'nama saya', 'saya suka', 'saya tidak suka', 'preferensi', 'kesukaan',
      'alamat', 'nomor', 'email', 'ulang tahun', 'hobi', 'pekerjaan'
    ];
    const shouldSave = importantKeywords.some(keyword => 
      combinedContent.toLowerCase().includes(keyword)
    );
    if (shouldSave) {
      const vectorStore = await this.getOrCreateVectorStore(sessionId);
      const doc = new Document({
        pageContent: `Important: ${combinedContent}`,
        metadata: {
          timestamp: new Date().toISOString(),
          type: 'preference',
          sessionId: sessionId
        }
      });
      await vectorStore.addDocuments([doc]);
      await this.saveVectorStore(sessionId);
    }
  }

  async saveVectorStore(sessionId) {
    const vectorStore = this.vectorStores.get(sessionId);
    if (vectorStore) {
      const storePath = this.getLongTermMemoryPath(sessionId);
      await vectorStore.save(storePath);
    }
  }

  async searchMemories(query, sessionId, k = 5) {
    const vectorStore = await this.getOrCreateVectorStore(sessionId);
    const results = await vectorStore.similaritySearchWithScore(query, k);
    return results.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
      score: score
    }));
  }

  async deleteMemory(sessionId, query, threshold = 0.7) {
    const vectorStore = await this.getOrCreateVectorStore(sessionId);
    const results = await vectorStore.similaritySearchWithScore(query, 10);
    const toDelete = results
      .filter(([_, score]) => score >= threshold)
      .map(([doc, _]) => doc);
    if (toDelete.length === 0) {
      return { deleted: 0, message: 'No memories found matching criteria' };
    }
    const storePath = this.getLongTermMemoryPath(sessionId);
    await vectorStore.delete({ ids: toDelete.map(d => d.metadata.id || d.pageContent) });
    await vectorStore.save(storePath);
    return { 
      deleted: toDelete.length, 
      message: `Deleted ${toDelete.length} memories` 
    };
  }

  async getAllMemories(sessionId, limit = 100) {
    const vectorStore = await this.getOrCreateVectorStore(sessionId);
    const index = vectorStore.index;
    if (!index || typeof index.ntotal !== 'function' || index.ntotal() === 0) {
      return [];
    }
    const dummyQuery = new Array(384).fill(0);
    const results = await vectorStore.similaritySearchWithScore(
      dummyQuery.join(' '), 
      Math.min(limit, index.ntotal())
    );
    return results.map(([doc, score]) => ({
      content: doc.pageContent,
      metadata: doc.metadata,
      score: score
    }));
  }

  async clearAllMemories(sessionId) {
    const storePath = this.getLongTermMemoryPath(sessionId);
    if (existsSync(storePath)) {
      rmSync(storePath, { recursive: true, force: true });
    }
    this.vectorStores.delete(sessionId);
    return { message: 'All long-term memories cleared' };
  }

  async getMemoryStats(sessionId) {
    await this.getOrCreateVectorStore(sessionId);
    const vectorStore = this.vectorStores.get(sessionId);
    const index = vectorStore?.index;
    const longTermCount = index && typeof index.ntotal === 'function' ? index.ntotal() : 0;
    const shortTermCount = (await this.loadChatHistory(sessionId)).length;
    return {
      sessionId,
      shortTermMemory: {
        count: shortTermCount,
        maxCapacity: this.maxShortTermMessages,
        filePath: this.getShortTermMemoryFile(sessionId)
      },
      longTermMemory: {
        count: longTermCount,
        path: this.getLongTermMemoryPath(sessionId)
      }
    };
  }
}
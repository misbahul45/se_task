import { Embeddings } from '@langchain/core/embeddings';
import { pipeline } from '@xenova/transformers';

export class XenovaEmbeddings extends Embeddings {
  constructor(params = {}) {
    super(params);
    this.modelName = params.modelName || 'Xenova/all-MiniLM-L6-v2';
    this.instance = null;
  }

  async getInstance() {
    if (!this.instance) {
      this.instance = await pipeline('feature-extraction', this.modelName);
    }
    return this.instance;
  }

  async embedDocuments(texts) {
    const instance = await this.getInstance();
    const embeddings = [];
    
    for (const text of texts) {
      const result = await instance(text, { pooling: 'mean', normalize: true });
      embeddings.push(Array.from(result.data));
    }
    
    return embeddings;
  }

  async embedQuery(text) {
    const instance = await this.getInstance();
    const result = await instance(text, { pooling: 'mean', normalize: true });
    return Array.from(result.data);
  }
}
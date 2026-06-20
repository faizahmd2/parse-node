const { Worker } = require('bullmq');
const path = require('path');
const connection = require('../queue/connection');
const { updateJobStatus } = require('../db/jobsRepo');
const { createDocument, insertChunks } = require('../db/documentsRepo');
const { parseFile, chunkText, embedTexts } = require('../services/pythonService');
const fs = require('fs');

const worker = new Worker(
  'ingestion',
  async (job) => {
    const { jobId, filePath, filename } = job.data;
    console.log(`Processing job ${jobId} - file: ${filename}`);

    // Stage 1: Parse
    await updateJobStatus(jobId, { status: 'processing', stage: 'parsing', progress: 25 });
    const absolutePath = path.resolve(filePath);
    console.log(`Parsing file at: ${absolutePath}`,fs.existsSync(absolutePath) ? 'File exists' : 'File does not exist');
    const markdown = await parseFile(absolutePath);
    if(!markdown) {
      throw new Error('Parsing failed - no content returned');
    }
    
    console.log(`Parsed content length: ${markdown.length} characters`);

    // Save document
    const doc = await createDocument({ jobId, filename, content: markdown });

    // Stage 2: Chunk
    // all-MiniLM-L6-v2 truncates anything past 256 word-pieces (~1000-1100 chars).
    // Chunks bigger than that just lose their tail silently during embedding,
    // so 900 chars (~210 tokens) leaves margin while keeping chunks as large as possible.
    await updateJobStatus(jobId, { stage: 'chunking', progress: 50 });
    const CHUNK_SIZE = 900;
    const chunks = await chunkText(markdown, CHUNK_SIZE);
    console.log(`Chunked into ${chunks.length} pieces`);

    if (chunks.length === 0) {
      throw new Error('No content extracted - chunking returned empty');
    }

    // Stage 3: Embed
    await updateJobStatus(jobId, { stage: 'embedding', progress: 75 });
    const embeddings = await embedTexts(chunks);
    console.log(`Generated embeddings for ${embeddings.length} chunks`);

    // Combine and store
    const chunksWithEmbeddings = chunks.map((content, i) => ({
      content,
      embedding: embeddings[i],
    }));
    await insertChunks(doc.id, chunksWithEmbeddings);

    // Done
    await updateJobStatus(jobId, { status: 'done', stage: 'complete', progress: 100 });

    // Clean
    if(fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
    }

    return { success: true, chunkCount: chunks.length };
  },
  { connection, concurrency: 1 }
);

worker.on('failed', async (job, err) => {
  const { jobId } = job.data;
  await updateJobStatus(jobId, { status: 'failed', error: err.message });
  console.error(`Job ${jobId} failed:`, err.message);
});

console.log('Worker started...');
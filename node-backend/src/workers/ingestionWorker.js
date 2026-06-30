const { Worker } = require('bullmq');
const path = require('path');
const connection = require('../queue/connection');
const { updateJobStatus } = require('../db/jobsRepo');
const { createDocument, updateDocumentMarkdown } = require('../db/documentsRepo');
const { parseFile, formatMarkdown } = require('../services/pythonService');
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

    await updateJobStatus(jobId, { stage: 'created', progress: 50 });
    
    const formatResult = await formatMarkdown(markdown, filename).catch((err) => {
      console.error(`Job ${jobId}: markdown formatting request failed:`, err.message);
      return { markdown: null, verified: false, reason: 'request_failed' };
    });
    
    if (formatResult.verified && formatResult.markdown) {
      await updateDocumentMarkdown(doc.id, formatResult.markdown);
    } else {
      console.warn(`Job ${jobId}: no formatted markdown stored (${formatResult.reason || 'unknown'})`);
    }

    // Done
    await updateJobStatus(jobId, { status: 'done', stage: 'complete', progress: 100 });

    // Clean
    if(fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
    }

    return { success: true };
  },
  { connection, concurrency: 1 }
);

worker.on('failed', async (job, err) => {
  const { jobId } = job.data;
  await updateJobStatus(jobId, { status: 'failed', error: err.message });
  console.error(`Job ${jobId} failed:`, err.message);
});

console.log('Worker started...');
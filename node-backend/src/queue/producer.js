const ingestionQueue = require('./ingestionQueue');

async function addJob(data) {
  const job = await ingestionQueue.add('process-document', data, {
    attempts: 3,                    // retry on failure
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600 }, // cleanup after 1hr
    removeOnFail: false,            // keep failed jobs for debugging
  });
  console.log(`Job added: ${job.id}`);
  return job.id;
}

// Test: run this file directly to add a dummy job
if (require.main === module) {
  addJob({ filePath: '/Users/faiz/Downloads/Faiz_Ahmad_Resume.pdf', filename: 'Faiz_Ahmad_Resume.pdf' })
    .then(() => process.exit(0));
}

module.exports = { addJob };
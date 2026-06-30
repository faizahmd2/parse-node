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

module.exports = { addJob };
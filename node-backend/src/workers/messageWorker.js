const { Worker } = require('bullmq');
const connection = require('../queue/connection');
const { getMessage, updateMessage } = require('../db/messagesRepo');
const { getClientCategories } = require('../db/clientsRepo');
const { findMatchingRoute } = require('../db/routingRepo');
const { executeDestination } = require('../services/destinationExecutor');
const { embedTexts, preprocessEmail } = require('../services/pythonService');
const axios = require('axios');

const PYTHON_SERVICE_URL = 'http://localhost:8000';

async function classify(text, categories, urgencyLevels) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/classify`, {
    text,
    categories: categories.map(c => c.value),
    urgency_levels: urgencyLevels.map(u => u.value),
  });
  return res.data;
}

const worker = new Worker(
  'messages',
  async (job) => {
    const { messageId } = job.data;
    const message = await getMessage(messageId);

    await updateMessage(messageId, { status: 'processing' });

    // Fetch client seeds for semantic filter
    const clientResult = await pool.query(
      `SELECT value, description FROM client_categories 
       WHERE client_id = $1 AND type = 'important_seed'`,
      [message.client_id]
    );
    const clientSeeds = clientResult.rows.map(r => r.description || r.value);

    // Stage 1-3: Preprocess
    const preprocess = await preprocessEmail({
      subject: message.subject,
      body: message.body,
      fromAddress: message.from_identifier,
      clientSeeds,
    });

    if (!preprocess.proceed) {
      // Not worth classifying — store reason, mark done quietly
      await updateMessage(messageId, {
        status: 'done',
        routing_status: 'filtered',
        classification: { filtered_reason: preprocess.reason, stage: preprocess.stage },
      });
      return { success: true, filtered: true, reason: preprocess.reason };
    }

    // Stage 4: Classify (only emails that passed all filters reach here)
    const { categories, urgencyLevels } = await getClientCategories(message.client_id);

    const classification = await classify(
      preprocess.text, // use CLEAN text, not raw body
      categories,
      urgencyLevels
    );

    // Confidence gate — if classifier isn't sure, don't alert
    if (classification.category_confidence < 0.6 || classification.urgency_confidence < 0.6) {
      await updateMessage(messageId, {
        status: 'done',
        routing_status: 'low_confidence',
        classification,
      });
      return { success: true, filtered: true, reason: 'low_confidence' };
    }

    const [embedding] = await embedTexts([preprocess.text]);
    const vectorStr = `[${embedding.join(',')}]`;

    await updateMessage(messageId, {
      embedding: vectorStr,
      classification,
    });

    // Stage 5: Route — strict matching
    const route = await findMatchingRoute(message.client_id, classification);

    if (!route) {
      await updateMessage(messageId, { status: 'done', routing_status: 'unrouted' });
      return { success: true, routed: false };
    }

    try {
      await executeDestination(route, message, classification);
      await updateMessage(messageId, {
        status: 'done',
        routed_to: route.destination_id,
        routing_status: 'sent',
      });
    } catch (err) {
      await updateMessage(messageId, {
        status: 'done',
        routing_status: 'failed',
      });
      throw err;
    }

    return { success: true, routed: true };
  },
  { connection, concurrency: 1 }
);

worker.on('failed', async (job, err) => {
  const { messageId } = job.data;
  await updateMessage(messageId, { status: 'failed' });
  console.error(`Message ${messageId} failed:`, err.message);
});

console.log('Message worker started...');
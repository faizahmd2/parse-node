const axios = require('axios');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

async function parseFile(filePath) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/parse`, { file_path: filePath });
  // console.log(`parseFile response:`, res.data);
  return res.data.markdown;
}

async function chunkText(text, chunkSize = 500) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/chunk`, { text, chunk_size: chunkSize });
  return res.data.chunks;
}

async function embedTexts(texts) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/embed`, { texts });
  return res.data.embeddings;
}

async function preprocessEmail({ subject, body, fromAddress, clientSeeds = [] }) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/preprocess`, {
    subject,
    body,
    from_address: fromAddress,
    client_seeds: clientSeeds,
  });
  return res.data;
}

module.exports = { parseFile, chunkText, embedTexts, preprocessEmail };
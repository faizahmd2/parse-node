const axios = require('axios');

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';

async function parseFile(filePath) {
  const res = await axios.post(`${PYTHON_SERVICE_URL}/parse`, { file_path: filePath });
  // console.log(`parseFile response:`, res.data);
  return res.data.markdown;
}

async function formatMarkdown(text, filename = '') {
  // return {verified: true, markdown: text} // for temp
  const res = await axios.post(`${PYTHON_SERVICE_URL}/format`, { text, filename });
  return res.data; // { markdown, verified, reason?, missing_tokens? }
}

module.exports = { parseFile, formatMarkdown };
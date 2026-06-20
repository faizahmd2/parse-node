const { Queue } = require('bullmq');
const connection = require('./connection');

const ingestionQueue = new Queue('ingestion', { connection });

module.exports = ingestionQueue;
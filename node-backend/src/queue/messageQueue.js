const { Queue } = require('bullmq');
const connection = require('./connection');

const messageQueue = new Queue('messages', { connection });

module.exports = messageQueue;
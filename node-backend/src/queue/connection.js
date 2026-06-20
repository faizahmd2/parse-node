const { Redis } = require('ioredis');

const connection = new Redis({
  host: process.env.REDIS_HOST || 'http://127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null, // required by BullMQ
});

module.exports = connection;
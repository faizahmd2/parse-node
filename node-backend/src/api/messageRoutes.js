const express = require('express');
const router = express.Router();
const { authenticateClient } = require('../middleware/auth');
const { createMessage, getMessage } = require('../db/messagesRepo');
const messageQueue = require('../queue/messageQueue');

router.post('/message', authenticateClient, async (req, res) => {
  const { channel, from, to, subject, body, metadata } = req.body;

  if (!channel || !body) {
    return res.status(400).json({ error: 'channel and body are required' });
  }

  const message = await createMessage({
    clientId: req.client.id,
    channel, from, to, subject, body, metadata,
  });

  await messageQueue.add('process-message', { messageId: message.id });

  res.json({ messageId: message.id, status: 'queued' });
});

router.get('/message/:id', authenticateClient, async (req, res) => {
  const message = await getMessage(req.params.id);
  if (!message || message.client_id !== req.client.id) {
    return res.status(404).json({ error: 'Message not found' });
  }
  res.json(message);
});

module.exports = router;
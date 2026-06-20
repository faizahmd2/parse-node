const axios = require('axios');

async function executeDestination(destination, message, classification) {
  const { destination_type, destination_config } = destination;

  switch (destination_type) {
    case 'webhook':
    case 'slack':
      return await sendWebhook(destination_config, message, classification);
    
    case 'telegram':
      return await sendTelegram(destination_config, message, classification);

    default:
      throw new Error(`Unsupported destination type: ${destination_type}`);
  }
}

async function sendTelegram(config, message, classification) {
  const { bot_token, chat_id } = config;
  
  const text = formatTelegramMessage(message, classification);

  const res = await axios.post(
    `https://api.telegram.org/bot${bot_token}/sendMessage`,
    {
      chat_id,
      text,
      parse_mode: 'Markdown',
    },
    { timeout: 5000 }
  );

  return { status: res.status };
}

function formatTelegramMessage(message, classification) {
  const urgencyEmoji = classification.urgency === 'high' ? '🔴' : '🟡';
  
  return `${urgencyEmoji} *${classification.category}* (${classification.urgency})\n\n` +
    `*From:* ${message.from_identifier}\n` +
    (message.subject ? `*Subject:* ${message.subject}\n` : '') +
    `\n${message.body.substring(0, 300)}${message.body.length > 300 ? '...' : ''}`;
}

async function sendWebhook(config, message, classification) {
  const payload = {
    message_id: message.id,
    channel: message.channel,
    from: message.from_identifier,
    subject: message.subject,
    body: message.body,
    classification,
    received_at: message.created_at,
  };

  const res = await axios.post(config.url, payload, {
    headers: config.headers || {},
    timeout: 5000,
  });

  return { status: res.status };
}

module.exports = { executeDestination };
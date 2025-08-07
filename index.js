const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode-terminal');

const app = express();
app.use(express.json());

const client = new Client({
  authStrategy: new LocalAuth(), // persist sessions
});

client.on('qr', (qr) => {
  console.log('Scan this QR code:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp Web is ready!');
});

client.initialize();

// Send message API
app.post('/send', async (req, res) => {
  const { number, message } = req.body;
  try {
    await client.sendMessage(`${number}@c.us`, message);
    res.send({ success: true });
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('WhatsApp Bot is running'));

app.listen(10000, () => console.log('Server listening on port 10000'));

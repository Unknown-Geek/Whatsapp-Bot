const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

// Config
const PORT = process.env.PORT || 10000;
const SESSION_PATH = process.env.SESSION_PATH || '.session';

// WhatsApp client state
let isReady = false;
let isAuthenticated = false;
let lastQR = null; // string content of last QR

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }), // persist sessions to configured path
  restartOnAuthFail: true,
  takeoverOnConflict: true,
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ],
  },
});

client.on('qr', (qr) => {
  lastQR = qr;
  console.log('[whatsapp] New QR received. Scan it to log in.');
  // Also print an ASCII QR in the terminal for convenience
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('authenticated', () => {
  isAuthenticated = true;
  console.log('[whatsapp] Authenticated');
});

client.on('auth_failure', (msg) => {
  isAuthenticated = false;
  console.error('[whatsapp] Authentication failure:', msg);
});

client.on('ready', () => {
  isReady = true;
  console.log('[whatsapp] WhatsApp Web client is ready');
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.warn('[whatsapp] Disconnected:', reason);
  // attempt to auto-recover
  setTimeout(() => {
    try {
      console.log('[whatsapp] Reinitializing client after disconnect...');
      client.initialize();
    } catch (e) {
      console.error('[whatsapp] Reinitialize failed:', e.message);
    }
  }, 1500);
});

client.on('message', async (msg) => {
  // Simple auto-reply example (disabled by default). Uncomment to enable.
  // if (msg.body?.toLowerCase() === 'ping') {
  //   await client.sendMessage(msg.from, 'pong');
  // }
});

client.initialize();

// Helpers
function toWhatsAppId(number) {
  // Accept E.164 with or without '+', or plain digits
  // Strip non-digits and append WhatsApp suffix
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

function requireReady(res) {
  if (!isReady) {
    return res.status(503).json({ error: 'client_not_ready', message: 'WhatsApp client not ready yet. Scan QR and wait for ready event.' });
  }
  return null;
}

// Routes
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    ready: isReady,
    authenticated: isAuthenticated,
    hasQR: Boolean(lastQR && !isReady),
  });
});

// Return the latest QR as PNG image (or 204 if already ready)
app.get('/qr.png', async (req, res) => {
  if (isReady) return res.status(204).end();
  if (!lastQR) return res.status(404).json({ error: 'no_qr_yet' });
  try {
    res.setHeader('Content-Type', 'image/png');
    const stream = await QRCode.toBuffer(lastQR, { type: 'png', width: 300, margin: 1 });
    return res.send(stream);
  } catch (e) {
    return res.status(500).json({ error: 'qr_generation_failed', message: e.message });
  }
});

// Return the latest QR content as JSON/text (useful for curl)
app.get('/qr', (req, res) => {
  if (isReady) return res.status(204).end();
  if (!lastQR) return res.status(404).json({ error: 'no_qr_yet' });
  return res.json({ qr: lastQR });
});

// Send text message
app.post('/send', async (req, res) => {
  if (requireReady(res)) return; // ensure client is ready
  const { number, message, jid } = req.body || {};
  if (!message || (!number && !jid)) {
    return res.status(400).json({ error: 'bad_request', message: "'message' and either 'number' or 'jid' are required" });
  }
  try {
    const to = jid || toWhatsAppId(number);
    if (!to) return res.status(400).json({ error: 'invalid_number' });
    await client.sendMessage(to, String(message));
    res.json({ success: true, to });
  } catch (err) {
    res.status(500).json({ error: 'send_failed', message: err.message });
  }
});

// Get contacts (optionally filtered by query)
app.get('/contacts', async (req, res) => {
  if (requireReady(res)) return;
  try {
    const query = String(req.query.query || req.query.q || '').trim().toLowerCase();
    const contacts = await client.getContacts();
    const mapped = contacts
      .filter((c) => c.isMyContact || c.isEnterprise || c.isWAContact)
      .map((c) => ({
        id: c.id?._serialized,
        jid: c.id?._serialized,
        user: c.id?.user,
        server: c.id?.server,
        number: c.number || c.id?.user,
        name: c.name || null,
        pushname: c.pushname || null,
        shortName: c.shortName || null,
        isMyContact: Boolean(c.isMyContact),
        isGroup: c.isGroup || false,
      }));
    const results = query
      ? mapped.filter((c) =>
          [c.name, c.pushname, c.shortName, c.number]
            .filter(Boolean)
            .some((v) => String(v).toLowerCase().includes(query))
        )
      : mapped;
    res.json({ count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: 'contacts_failed', message: err.message });
  }
});

// Send message to a contact by name (best-effort matching)
app.post('/send-by-name', async (req, res) => {
  if (requireReady(res)) return;
  const { name, message } = req.body || {};
  if (!name || !message) {
    return res.status(400).json({ error: 'bad_request', message: "'name' and 'message' are required" });
  }
  const q = String(name).trim().toLowerCase();
  try {
    const contacts = await client.getContacts();
    const candidates = contacts
      .filter((c) => (c.isMyContact || c.isWAContact) && !c.isGroup)
      .map((c) => ({
        contact: c,
        score: [c.name, c.pushname, c.shortName, c.number, c.id?.user]
          .filter(Boolean)
          .reduce((acc, v) => (String(v).toLowerCase().includes(q) ? acc + 1 : acc), 0),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) {
      return res.status(404).json({ error: 'no_match', message: 'No contact matched query', query: name });
    }

    // If multiple have the same top score, return choices unless only one is clearly the best
    const topScore = candidates[0].score;
    const top = candidates.filter((c) => c.score === topScore);
    if (top.length > 1) {
      return res.status(300).json({
        error: 'ambiguous',
        message: 'Multiple contacts matched. Refine your name or use /send with number/jid.',
        candidates: top.slice(0, 10).map(({ contact }) => ({
          jid: contact.id?._serialized,
          number: contact.number || contact.id?.user,
          name: contact.name || contact.pushname || contact.shortName || null,
        })),
      });
    }

    const chosen = candidates[0].contact;
    const jid = chosen.id?._serialized;
    if (!jid) return res.status(500).json({ error: 'invalid_contact', message: 'Selected contact has no JID' });
    await client.sendMessage(jid, String(message));
    return res.json({ success: true, to: jid, name: chosen.name || chosen.pushname || chosen.shortName || null });
  } catch (err) {
    res.status(500).json({ error: 'send_by_name_failed', message: err.message });
  }
});

// Basic not-found handler
app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();

// Add logging middleware to debug requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json({
  limit: '10mb'
}));

// Config
const PORT = process.env.PORT || 10000;
const SESSION_PATH = process.env.SESSION_PATH || '.session';

// WhatsApp client state
let isReady = false;
let isAuthenticated = false;
let lastQR = null; // string content of last QR
let client = null;

function buildClient() {
  return new Client({
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
        '--window-size=1280,800'
      ],
    },
    // Let library auto-manage web version; removing pinned remote HTML which can break when outdated
  });
}

function initializeClient() {
  if (client) {
    try { client.removeAllListeners(); } catch (_) {}
  }
  client = buildClient();
  wireClientEvents(client);
  try {
    client.initialize();
  } catch (err) {
    console.error('[whatsapp] Failed to initialize client:', err);
  }
}

function clearSessionData() {
  try {
    const authPath = path.resolve(SESSION_PATH, 'whatsapp-web.js');
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('[whatsapp] Cleared session data at', authPath);
    }
  } catch (e) {
    console.warn('[whatsapp] Failed to clear session data:', e.message);
  }
}

function wireClientEvents(c) {
  c.on('qr', (qr) => {
    lastQR = qr;
    console.log('[whatsapp] New QR received. Scan it to log in.');
    qrcodeTerminal.generate(qr, { small: true });
  });

  c.on('authenticated', () => {
    isAuthenticated = true;
    console.log('[whatsapp] Authenticated');
  });

  c.on('auth_failure', (msg) => {
    isAuthenticated = false;
    console.error('[whatsapp] Authentication failure:', msg);
  });

  c.on('ready', () => {
    isReady = true;
    console.log('[whatsapp] WhatsApp Web client is ready');
  });

  c.on('disconnected', async (reason) => {
    isReady = false;
    isAuthenticated = false;
    console.warn('[whatsapp] Disconnected:', reason);

    if (reason === 'LOGOUT') {
      // Session invalidated; must clear and rebuild new client requiring fresh QR
      console.log('[whatsapp] Handling LOGOUT: clearing session and creating new client');
      clearSessionData();
      try { await c.destroy(); } catch (_) {}
      lastQR = null;
      setTimeout(() => initializeClient(), 3000);
      return;
    }

    // Only attempt to auto-recover for certain disconnect reasons
    if (reason === 'NAVIGATION' || reason === 'CONFLICT') {
      console.log('[whatsapp] Auto-recovery not recommended for reason:', reason);
      return;
    }

    setTimeout(() => {
      try {
        console.log('[whatsapp] Reinitializing existing client after disconnect...');
        c.initialize();
      } catch (e) {
        console.error('[whatsapp] Reinitialize failed, rebuilding client:', e.message);
        initializeClient();
      }
    }, 5000);
  });

  c.on('message', async (msg) => {
    // placeholder for auto-reply logic
  });

  c.on('error', (error) => {
    console.error('[whatsapp] Client error:', error);
  });
}

// Initialize first client
initializeClient();

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

// Test JSON parsing endpoint
app.post('/test-json', (req, res) => {
  console.log('Test JSON endpoint called');
  console.log('Request body:', req.body);
  res.json({ 
    success: true, 
    received: req.body
  });
});

// Manual restart endpoint
app.post('/restart', (req, res) => {
  try {
    isReady = false;
    isAuthenticated = false;
    lastQR = null;
    console.log('[whatsapp] Manual restart requested');
    client.destroy();
    setTimeout(() => {
      client.initialize();
    }, 2000);
    res.json({ success: true, message: 'Client restart initiated' });
  } catch (err) {
    res.status(500).json({ error: 'restart_failed', message: err.message });
  }
});

// Send text message
app.post('/send', async (req, res) => {
  console.log('Send endpoint called');
  console.log('Request body:', req.body);
  
  if (requireReady(res)) return; // ensure client is ready
  
  const { number, message, jid } = req.body || {};
  
  console.log('Parsed values:', { number, message, jid });
  
  if (!message || (!number && !jid)) {
    console.log('Bad request: missing required fields');
    return res.status(400).json({ 
      error: 'bad_request', 
      message: "'message' and either 'number' or 'jid' are required",
      received: { number, message, jid }
    });
  }
  
  try {
    const to = jid || toWhatsAppId(number);
    if (!to) {
      console.log('Invalid number:', number);
      return res.status(400).json({ error: 'invalid_number', number });
    }
    
    console.log('Sending message to:', to);
    await client.sendMessage(to, String(message));
    console.log('Message sent successfully');
    res.json({ success: true, to });
  } catch (err) {
    console.error('Send failed:', err);
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

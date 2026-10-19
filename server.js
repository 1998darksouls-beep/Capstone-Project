const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'webhook-config.json');
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

// Default webhook URL from Voiceflow / n8n export
const DEFAULT_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://reoccur-sterilize-endnote.ngrok-free.dev/webhook/ai-receptionist-booking';

// Helper to load webhook configuration
function getWebhookConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (data && data.webhookUrl) return data.webhookUrl;
    }
  } catch (err) {
    console.error('Error reading webhook config:', err.message);
  }
  return DEFAULT_WEBHOOK_URL;
}

// Helper to save webhook configuration
function saveWebhookConfig(url) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ webhookUrl: url, updatedAt: new Date().toISOString() }, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving webhook config:', err.message);
    return false;
  }
}

// Helper to append a booking locally
function logBookingLocally(booking) {
  try {
    let bookings = [];
    if (fs.existsSync(BOOKINGS_FILE)) {
      try {
        bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
      } catch (e) {
        bookings = [];
      }
    }
    bookings.unshift(booking);
    // Keep last 100 bookings
    if (bookings.length > 100) bookings = bookings.slice(0, 100);
    fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
  } catch (err) {
    console.error('Error saving booking locally:', err.message);
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.vf': 'application/json'
};

const server = http.createServer(async (req, res) => {
  // Set CORS headers for API requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // ==========================================
  // API ROUTE: Forward Booking to n8n Webhook
  // ==========================================
  if (pathname === '/api/webhook/booking' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');

        // Normalize payload to match n8n workflow exact keys
        const bookingData = {
          channel: payload.channel || 'Voiceflow Chatbot',
          customer_name: payload.customer_name || 'Guest Client',
          customer_phone: payload.customer_phone || '',
          customer_email: payload.customer_email || '',
          selected_service: payload.selected_service || 'General VIP Appointment',
          appointment_time: payload.appointment_time || new Date().toLocaleString(),
          status: payload.status || 'Confirmed',
          escalation_reason: payload.escalation_reason || ''
        };

        const bookingId = 'AG-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const record = {
          id: bookingId,
          timestamp: new Date().toISOString(),
          ...bookingData
        };

        // Log locally first so data is never lost
        logBookingLocally(record);
        console.log(`\n[AURA GLOW] New Booking Request [${bookingId}]:`, JSON.stringify(record, null, 2));

        const targetWebhook = getWebhookConfig();
        console.log(`[AURA GLOW] Forwarding to n8n Webhook: ${targetWebhook}`);

        let n8nSuccess = false;
        let n8nDetails = null;
        let errorMessage = null;

        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);

          const n8nRes = await fetch(targetWebhook, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'ngrok-skip-browser-warning': 'true', // Skip ngrok browser warning page
              'User-Agent': 'AuraGlowStudio-Webchat/1.0'
            },
            body: JSON.stringify(bookingData),
            signal: controller.signal
          });
          clearTimeout(timeout);

          n8nDetails = { status: n8nRes.status, statusText: n8nRes.statusText };
          console.log(`[AURA GLOW] n8n Webhook response status: ${n8nRes.status}`);

          if (n8nRes.ok) {
            n8nSuccess = true;
            try {
              const text = await n8nRes.text();
              n8nDetails.data = text ? JSON.parse(text) : 'OK';
            } catch (e) {
              n8nDetails.data = 'OK';
            }
          } else {
            errorMessage = `n8n returned status ${n8nRes.status}`;
          }
        } catch (fetchErr) {
          console.warn('[AURA GLOW] n8n Webhook dispatch notice:', fetchErr.message);
          errorMessage = fetchErr.message;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          bookingId: bookingId,
          forwardedToN8n: n8nSuccess,
          n8nWebhookUrl: targetWebhook,
          n8nDetails: n8nDetails,
          notice: n8nSuccess 
            ? 'Booking successfully received and forwarded to n8n workflow (Google Sheets & Gmail)!' 
            : `Booking logged locally. (Notice: n8n webhook at ${targetWebhook} was not reached: ${errorMessage}. Make sure n8n or your tunnel is active).`,
          booking: record
        }));
      } catch (err) {
        console.error('Error handling booking request:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // ==========================================
  // API ROUTE: Get / Set Webhook Configuration
  // ==========================================
  if (pathname === '/api/webhook/config') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        webhookUrl: getWebhookConfig(),
        defaultWebhookUrl: DEFAULT_WEBHOOK_URL
      }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.webhookUrl && typeof data.webhookUrl === 'string') {
            saveWebhookConfig(data.webhookUrl.trim());
            console.log('[AURA GLOW] Updated n8n Webhook URL to:', data.webhookUrl.trim());
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, webhookUrl: data.webhookUrl.trim() }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Invalid webhookUrl' }));
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }
  }

  // ==========================================
  // API ROUTE: Test n8n Webhook Connection
  // ==========================================
  if (pathname === '/api/webhook/test' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const testUrl = (data.webhookUrl || getWebhookConfig()).trim();

        console.log(`[AURA GLOW] Testing connection to Webhook: ${testUrl}`);
        const testPayload = {
          channel: 'Connection Test',
          customer_name: 'Test Client',
          customer_phone: '+1 555 0199',
          customer_email: 'test@auraglow.example',
          selected_service: 'Luxury Hydrafacial',
          appointment_time: 'Test Check',
          status: 'Confirmed',
          escalation_reason: ''
        };

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const testRes = await fetch(testUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'ngrok-skip-browser-warning': 'true'
          },
          body: JSON.stringify(testPayload),
          signal: controller.signal
        });
        clearTimeout(timeout);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: testRes.ok,
          status: testRes.status,
          statusText: testRes.statusText,
          webhookUrl: testUrl
        }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: err.message,
          hint: 'Ensure n8n is running and your webhook node is active (Listen for Test Event or Activated Workflow).'
        }));
      }
    });
    return;
  }

  // ==========================================
  // API ROUTE: Get Recent Bookings
  // ==========================================
  if (pathname === '/api/bookings' && req.method === 'GET') {
    let bookings = [];
    try {
      if (fs.existsSync(BOOKINGS_FILE)) {
        bookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
      }
    } catch (e) {
      bookings = [];
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: bookings.length, bookings: bookings }));
    return;
  }

  // ==========================================
  // Static File Serving
  // ==========================================
  let reqPath = pathname === '/' ? 'index.html' : pathname.substring(1);
  // Protect against directory traversal
  let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, safePath);

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404 Not Found</h1><p>The requested file was not found.</p>');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  AURA GLOW STUDIO - LUXURY SALON & AESTHETIC CLINIC   `);
  console.log(`======================================================`);
  console.log(`  Server running at: http://localhost:${PORT}/`);
  console.log(`  n8n Webhook Target: ${getWebhookConfig()}`);
  console.log(`  Booking API:        http://localhost:${PORT}/api/webhook/booking`);
  console.log(`  Config API:         http://localhost:${PORT}/api/webhook/config`);
  console.log(`======================================================\n`);
});

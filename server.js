const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Load .env manually (no external dependencies needed)
function loadEnv() {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envFile.split('\n').forEach(line => {
      const [key, ...rest] = line.split('=');
      if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
    });
  } catch (e) {
    // .env not found — rely on real environment variables (production)
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error('❌ חסר GROQ_API_KEY — הוסף אותו ל-.env או להגדרות הסביבה');
  process.exit(1);
}

// Simple in-memory rate limiter — max 10 requests per IP per hour
const rateLimitMap = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour
  const maxRequests = 10;
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count > maxRequests;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Proxy to Groq — key comes from server, not from client
  if (req.method === 'POST' && req.url === '/api/roast') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    if (isRateLimited(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'יותר מדי בקשות — נסה שוב בעוד שעה 🔥' } }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { decision } = JSON.parse(body); // no apiKey from client anymore

        if (!decision || decision.trim().length < 10) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'החלטה קצרה מדי' } }));
          return;
        }

        const groqPayload = JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 1.0,
          max_tokens: 1000,
          messages: [
            {
              role: 'system',
              content: `You are a brutal but funny roast comedian and life coach hybrid. You analyze decisions people made.
Respond ONLY in valid JSON, no markdown, no backticks. Use Hebrew language for all text values.
Return exactly this structure:
{
  "score": <number 0-100, how stupid/risky the decision was>,
  "verdict": <short 3-5 word uppercase verdict in Hebrew like "גאוני לחלוטין" or "טיפשות מדהימה">,
  "roast": <2-4 sentence funny roast in Hebrew, be savage but not mean>,
  "analysis": <2-3 sentences of genuine analysis of pros and cons in Hebrew>,
  "final": <1-2 sentence final bottom line verdict in Hebrew>
}`
            },
            {
              role: 'user',
              content: `ההחלטה שלי: ${decision}`
            }
          ]
        });

        const options = {
          hostname: 'api.groq.com',
          path: '/openai/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`,
            'Content-Length': Buffer.byteLength(groqPayload)
          }
        };

        const proxyReq = https.request(options, (proxyRes) => {
          let data = '';
          proxyRes.on('data', chunk => data += chunk);
          proxyRes.on('end', () => {
            res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });

        proxyReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message } }));
        });

        proxyReq.write(groqPayload);
        proxyReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Bad request: ' + e.message } }));
      }
    });
    return;
  }

  // Serve favicon
  if (req.url === '/favicon.png') {
    fs.readFile(path.join(__dirname, 'favicon.png'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }

  // Serve HTML file
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'roast-my-decision.html'), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n🔥 Roast My Decision רץ על http://localhost:${PORT}`);
  console.log('פתח את הדפדפן וגש לכתובת הזו\n');
});

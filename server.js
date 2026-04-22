/**
 * VNCX LeadHunter — Local Proxy Server
 * Zero dependencies — uses only Node.js built-in modules
 *
 * HOW TO START:
 *   node server.js
 *
 * Then open index.html (or vncx-leadhunter.html) in your browser.
 * The server runs on http://localhost:3001
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3001;

// ─── helpers ────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function httpsGet(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'VNCX-LeadHunter/1.0', 'Accept': 'application/json' },
      timeout: 25000
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data.slice(0, 300) } }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const bodyStr = JSON.stringify(payload);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'VNCX-LeadHunter/1.0'
      },
      timeout: 30000
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { error: data.slice(0, 300) } }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
}

// ─── server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // ── Serve the HTML app ──────────────────────────────────────────────────
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    // Try vncx-leadhunter.html first, then index.html
    const candidates = ['vncx-leadhunter.html', 'index.html'];
    for (const f of candidates) {
      const fp = path.join(__dirname, f);
      if (fs.existsSync(fp)) return sendFile(res, fp);
    }
    res.writeHead(404); res.end('vncx-leadhunter.html not found in this folder');
    return;
  }

  // ── Health check ──────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/health') {
    return send(res, 200, { ok: true, message: 'VNCX LeadHunter server running' });
  }

  // ── SerpAPI proxy ────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/serp') {
    try {
      const { key, params } = await readBody(req);
      if (!key) return send(res, 400, { error: 'No SerpAPI key provided' });

      const target = new URL('https://serpapi.com/search.json');
      Object.entries({ ...params, api_key: key }).forEach(([k, v]) => target.searchParams.set(k, String(v)));

      console.log(`[SerpAPI] ${params.engine || 'search'} — ${params.q || params.place_id || '?'}`);
      const result = await httpsGet(target.toString());

      if (result.body && result.body.error) {
        console.error(`[SerpAPI] Error: ${result.body.error}`);
        return send(res, 400, { error: result.body.error });
      }
      return send(res, 200, result.body);
    } catch (e) {
      console.error('[SerpAPI] Exception:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // ── Gemini proxy ─────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/gemini') {
    try {
      const { key, prompt, max } = await readBody(req);
      if (!key) return send(res, 400, { error: 'No Gemini key provided' });
      
      /////new payload///
      const target = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${key}`;
      const payload = {
  contents: [{
    role: "user",
    parts: [{ text: `INSTRUCTIONS: You are a high-ticket specialist. Speak with absolute certainty. Use high-value "free bait" hooks. Be caring, curious, and helpful, yet dominant and demanding of attention.

    USER REQUEST: ${prompt}` }]
  }],
  generationConfig: {
    maxOutputTokens: 16384, // Increased significantly for complete output
    temperature: 0.85,     // High for assertive, creative tonality
    topP: 0.95
  }
};

//////
      console.log(`[Gemini] prompt length: ${prompt.length} chars, max tokens: ${max || 4096}`);
      const result = await httpsPost(target, payload);

      if (result.body && result.body.error) {
        console.error(`[Gemini] Error: ${result.body.error.message}`);
        return send(res, 400, { error: result.body.error.message });
      }

      const text = result.body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return send(res, 200, { text });
    } catch (e) {
      console.error('[Gemini] Exception:', e.message);
      return send(res, 500, { error: e.message });
    }
  }

  // 404
  send(res, 404, { error: 'Not found: ' + pathname });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ██╗   ██╗███╗   ██╗ ██████╗██╗  ██╗');
  console.log('  ██║   ██║████╗  ██║██╔════╝╚██╗██╔╝');
  console.log('  ██║   ██║██╔██╗ ██║██║      ╚███╔╝ ');
  console.log('  ╚██╗ ██╔╝██║╚██╗██║██║      ██╔██╗ ');
  console.log('   ╚████╔╝ ██║ ╚████║╚██████╗██╔╝ ██╗');
  console.log('    ╚═══╝  ╚═╝  ╚═══╝ ╚═════╝╚═╝  ╚═╝');
  console.log('');
  console.log('  LeadHunter Pro — Local Server');
  console.log('  ─────────────────────────────────────');
  console.log(`  Running at:  http://localhost:${PORT}`);
  console.log(`  App:         http://localhost:${PORT}/`);
  console.log('');
  console.log('  Open http://localhost:3001 in your browser.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either stop the other process or change PORT at the top of server.js\n`);
  } else {
    console.error('\n  Server error:', e.message, '\n');
  }
  process.exit(1);
});

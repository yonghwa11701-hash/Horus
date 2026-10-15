const { getDefaultConfig } = require('expo/metro-config');
const schema = require('./src/lib/voice/debug-schema.json');

const config = getDefaultConfig(__dirname);
const enhance = config.server.enhanceMiddleware;

// Dev-server endpoint only: never part of the exported app or Supabase API.
config.server.enhanceMiddleware = (middleware, server) => {
  const next = enhance ? enhance(middleware, server) : middleware;
  let windowStart = 0;
  let received = 0;
  return (req, res, done) => {
    if (process.env.NODE_ENV === 'production' || req.url?.split('?')[0] !== '/__horus/voice-debug') {
      return next(req, res, done);
    }
    // Browser callers must be same-origin. Native dev clients have no Origin header.
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) { res.writeHead(403).end(); return; }
      } catch { res.writeHead(403).end(); return; }
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; received = 0; }
    if (++received > 20) { res.writeHead(429).end(); req.resume(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      if (res.writableEnded) return;
      size += chunk.length;
      if (size > 8192) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => {});
    req.on('end', () => {
      if (size > 8192) return;
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || !schema.events.includes(input.kind)) { res.writeHead(400).end(); return; }
        // Drop unknown fields, especially text/audio/headers/keys, before logging anything.
        const safe = { kind: input.kind };
        for (const key of schema.numbers) {
          if (typeof input[key] === 'number' && Number.isFinite(input[key]) && input[key] >= 0 && input[key] <= 1e12) safe[key] = input[key];
        }
        for (const key of schema.booleans) if (typeof input[key] === 'boolean') safe[key] = input[key];
        for (const [key, values] of Object.entries(schema.strings)) if (values.includes(input[key])) safe[key] = input[key];
        if (typeof input.last_event === 'string' && /^[a-z_]{1,64}$/.test(input.last_event)) safe.last_event = input.last_event;
        console.info(`[horus:voice ${new Date().toISOString()}] ${JSON.stringify(safe)}`);
        res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
      } catch { res.writeHead(400).end(); }
    });
  };
};

module.exports = config;

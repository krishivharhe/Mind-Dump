const https = require('https');

const rateLimitMap = new Map();
const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 1000;

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_WINDOW; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry;
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({}); }
    });
  });
}

const ORGANIZE_PROMPT = `You are MindDump AI — a personal thought organizer.
The user will give you a raw messy brain dump. Analyze it and return a JSON array of organized items.
Each item must have: "title" (max 8 words), "category" (todo/goal/idea/note/event), "priority" (high/medium/low), "summary" (one sentence), "raw_text".
Rules: Split compound thoughts. Infer priority from urgency words.
Return ONLY a valid JSON array. No markdown, no explanation, no extra text.
Example: [{"title":"Call dentist","category":"todo","priority":"high","summary":"Schedule dentist appointment","raw_text":"call dentist asap"}]`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (getRateLimit(ip).count > RATE_LIMIT) return res.status(429).json({ error: 'Too many requests' });

  const body = await parseBody(req);
  const { text, model, apiKey } = body;

  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'No text provided' });
  if (text.length > 10000) return res.status(400).json({ error: 'Text too long' });

  const selectedModel = model || 'mistralai/mistral-7b-instruct';
  const selectedKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!selectedKey) return res.status(400).json({ error: 'No API key. Add your OpenRouter key in Settings.' });

  const reqBody = JSON.stringify({
    model: selectedModel,
    messages: [
      { role: 'system', content: ORGANIZE_PROMPT },
      { role: 'user', content: text }
    ],
    max_tokens: 2000,
    temperature: 0.3
  });

  try {
    const response = await httpsRequest({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${selectedKey}`,
        'HTTP-Referer': 'https://minddump.vercel.app',
        'X-Title': 'MindDump AI',
        'Content-Length': Buffer.byteLength(reqBody)
      }
    }, reqBody);

    if (response.status !== 200) {
      return res.status(response.status).json({ error: response.body?.error?.message || 'OpenRouter error' });
    }

    const content = response.body.choices?.[0]?.message?.content || '[]';
    let items;
    try {
      const cleaned = content.replace(/```json/g,'').replace(/```/g,'').trim();
      const match = cleaned.match(/\[[\s\S]*\]/);
      items = JSON.parse(match ? match[0] : cleaned);
      if (!Array.isArray(items)) items = [items];
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid format, please try again' });
    }

    return res.status(200).json({ items, usage: response.body.usage });
  } catch (err) {
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
};
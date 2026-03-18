const https = require('https');

// Rate limiting
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

const ORGANIZE_PROMPT = `You are MindDump AI — a personal thought organizer.
The user will give you a raw, messy brain dump — could be tasks, ideas, worries, goals, random thoughts, voice transcription, anything.

Your job is to analyze it and return a JSON array of organized items.

Each item must have:
- "title": short, clear title (max 8 words)
- "category": one of: "todo", "goal", "idea", "note", "event"
- "priority": one of: "high", "medium", "low"
- "summary": one sentence explaining what this is
- "raw_text": the original text that relates to this item

Rules:
- Split compound thoughts into separate items
- Infer priority from urgency words (urgent/asap/today = high, someday/maybe = low)
- "todo" = actionable task, "goal" = longer term aspiration, "idea" = creative thought, "note" = information to remember, "event" = time-based thing
- Return ONLY valid JSON array, no markdown, no explanation

Example output:
[
  {
    "title": "Call dentist for appointment",
    "category": "todo",
    "priority": "high",
    "summary": "Need to schedule a dentist appointment urgently",
    "raw_text": "call dentist asap"
  }
]`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (getRateLimit(ip).count > RATE_LIMIT) return res.status(429).json({ error: 'Too many requests' });

  const { text, model, apiKey } = req.body || {};
  if (!text || text.trim().length === 0) return res.status(400).json({ error: 'No text provided' });
  if (text.length > 10000) return res.status(400).json({ error: 'Text too long (max 10000 chars)' });

  const selectedModel = model || 'mistralai/mistral-7b-instruct';
  const selectedKey = apiKey || process.env.OPENROUTER_API_KEY;
  if (!selectedKey) return res.status(400).json({ error: 'No API key configured' });

  const body = JSON.stringify({
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
        'Content-Length': Buffer.byteLength(body)
      }
    }, body);

    if (response.status !== 200) {
      return res.status(response.status).json({ error: response.body?.error?.message || 'AI error' });
    }

    const content = response.body.choices?.[0]?.message?.content || '[]';
    let items;
    try {
      const cleaned = content.replace(/```json|```/g, '').trim();
      items = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({ error: 'AI returned invalid response, try again' });
    }

    return res.status(200).json({ items, usage: response.body.usage });
  } catch (err) {
    console.error('API error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
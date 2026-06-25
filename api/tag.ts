import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODELS = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const MAX_TAGS = 2;
const PROMPT =
  'Read this note and return 1 to 2 short, lowercase topic tags as a JSON array of strings, e.g. ["grocery"]. Use at most 2 tags. The TITLE is the strongest signal — tag from what the note is about overall, not one passing detail in the body. Prefer common tags like grocery, work, ideas, personal, school, health, recipes, travel. Use "personal" for life balance, wellness, relationships, hobbies, and self-reflection. Use "work" for meetings, projects, and job tasks. Do not use "work" when the title is clearly personal. Return only the JSON array.';

function splitNote(text: string): { title: string; body: string } {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return { title: lines[0] || '', body: lines.slice(1).join('\n') };
}

function formatNoteForModel(text: string): string {
  const { title, body } = splitNote(text);
  return `Title: ${title || '(untitled)'}\nBody: ${body || '(empty)'}`;
}

const PER_VISITOR_PER_MINUTE = 5;
const DAILY_TOTAL_LIMIT = 120;
const MAX_TEXT_LENGTH = 8000;

type Bucket = { minuteStart: number; minuteCount: number };
type RateStore = {
  visitors: Map<string, Bucket>;
  dayKey: string;
  dayCount: number;
};

const store: RateStore =
  (globalThis as typeof globalThis & { __tagRateStore?: RateStore }).__tagRateStore ??
  ((globalThis as typeof globalThis & { __tagRateStore?: RateStore }).__tagRateStore = {
    visitors: new Map(),
    dayKey: todayKey(),
    dayCount: 0,
  });

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function clientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const dayKey = todayKey();
  if (store.dayKey !== dayKey) {
    store.dayKey = dayKey;
    store.dayCount = 0;
  }
  if (store.dayCount >= DAILY_TOTAL_LIMIT) return true;

  const bucket = store.visitors.get(ip) ?? { minuteStart: now, minuteCount: 0 };
  if (now - bucket.minuteStart >= 60_000) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }
  if (bucket.minuteCount >= PER_VISITOR_PER_MINUTE) {
    store.visitors.set(ip, bucket);
    return true;
  }

  bucket.minuteCount += 1;
  store.visitors.set(ip, bucket);
  store.dayCount += 1;
  return false;
}

function parseTags(raw: string): string[] {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const arrayMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];
  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.toLowerCase().trim().replace(/^#/, ''))
      .filter(Boolean)
      .slice(0, MAX_TAGS);
  } catch {
    return [];
  }
}

function refineTags(tags: string[], text: string): string[] {
  const { title, body } = splitNote(text);
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();

  const personalTitle =
    /\b(life balance|wellness|wellbeing|family|personal|journal|self[- ]?care|mental health|relationships?|hobby|hobbies|gratitude|mindfulness|balance)\b/.test(
      titleLower,
    );
  const workTitle =
    /\b(meeting|meetings|sync|standup|work\b|client|quarterly|roadmap|interview|deadline|sprint)\b/.test(
      titleLower,
    );
  const workBody =
    /\b(meeting|meetings|sync|standup|client|quarterly|roadmap|interview|deadline|sprint)\b/.test(
      bodyLower,
    );

  let cleaned = [...tags];

  if (personalTitle && !workTitle) {
    cleaned = cleaned.filter((tag) => tag !== 'work');
    if (!cleaned.includes('personal')) cleaned.unshift('personal');
  } else if (workTitle || workBody) {
    cleaned = cleaned.filter((tag) => tag !== 'personal');
  }

  return [...new Set(cleaned)].slice(0, MAX_TAGS);
}

function fallbackTags(text: string): string[] {
  const { title, body } = splitNote(text);
  const combined = `${title}\n${body}`.toLowerCase();
  const picks: string[] = [];

  if (/\b(grocery|groceries|costco|shopping|olive oil|milk|bread)\b/.test(combined)) picks.push('grocery');
  if (/\b(workout|exercise|gym|cardio|upper body|health)\b/.test(combined)) picks.push('health');
  if (/\b(recipe|cooking|bake|dinner|kitchen)\b/.test(combined)) picks.push('recipes');
  if (/\b(school|homework|class|exam|study)\b/.test(combined)) picks.push('school');
  if (/\b(travel|flight|trip|vacation)\b/.test(combined)) picks.push('travel');
  if (/\b(idea|brainstorm|sketch)\b/.test(combined)) picks.push('ideas');
  if (/\b(life balance|wellness|wellbeing|personal|journal|family|hobby|mindfulness)\b/.test(combined)) {
    picks.push('personal');
  }
  if (/\b(meeting|meetings|sync|standup|work\b|project|client|internship|office|quarterly)\b/.test(combined)) {
    picks.push('work');
  }

  return refineTags([...new Set(picks)].slice(0, MAX_TAGS), text);
}

async function callGeminiModel(model: string, text: string, apiKey: string): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${PROMPT}\n\n${formatNoteForModel(text)}` }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 64,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const modelText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const tags = refineTags(parseTags(modelText), text);
  if (!tags.length) throw new Error('Gemini returned no tags');
  return tags;
}

async function tagWithGemini(text: string, apiKey: string): Promise<string[]> {
  let lastError: Error | null = null;
  for (const model of MODELS) {
    try {
      return await callGeminiModel(model, text, apiKey);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const retryable = /HTTP (429|503|500)/.test(lastError.message) || lastError.message.includes('no tags');
      if (!retryable) break;
    }
  }
  throw lastError ?? new Error('Gemini tagging failed');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: 'text too long' });
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'try again in a moment' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[api/tag] GEMINI_API_KEY is not configured');
    return res.status(503).json({ error: 'tagging unavailable' });
  }

  try {
    const tags = await tagWithGemini(text.slice(0, MAX_TEXT_LENGTH), apiKey);
    return res.status(200).json({ tags });
  } catch (error) {
    console.error('[api/tag] Gemini request failed', error);
    const tags = fallbackTags(text);
    if (tags.length) return res.status(200).json({ tags });
    return res.status(502).json({ error: 'tagging failed' });
  }
}

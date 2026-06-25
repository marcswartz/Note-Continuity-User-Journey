import type { VercelRequest, VercelResponse } from '@vercel/node';

const MODELS = ['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const MAX_TAGS = 2;
const PROMPT = `You tag Apple Notes for any topic someone might write.
Return 1 to 2 short lowercase topic tags as a JSON array of strings only, e.g. ["grocery"].
The TITLE is the strongest signal — infer what the note is about overall, not one passing name or detail.
Prefer these when they clearly fit: grocery, work, ideas, personal, school, health, recipes, travel.
If none fit well, still return the best short category tags for the note (e.g. pets, sports, home, finance).
Use "personal" for family, gifts, pets, errands, hobbies, and life admin.
Use "work" for meetings, projects, and job tasks — not for personal errands.
Never return an empty array.`;

const PER_VISITOR_PER_MINUTE = 30;
const MAX_TEXT_LENGTH = 8000;
const CACHE_TTL_MS = 60 * 60 * 1000;

type Bucket = { minuteStart: number; minuteCount: number };
type CacheEntry = { tags: string[]; expires: number };
type TagStore = {
  visitors: Map<string, Bucket>;
  cache: Map<string, CacheEntry>;
};

const store: TagStore =
  (globalThis as typeof globalThis & { __tagStore?: TagStore }).__tagStore ??
  ((globalThis as typeof globalThis & { __tagStore?: TagStore }).__tagStore = {
    visitors: new Map(),
    cache: new Map(),
  });

function splitNote(text: string): { title: string; body: string } {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  return { title: lines[0] || '', body: lines.slice(1).join('\n') };
}

function formatNoteForModel(text: string): string {
  const { title, body } = splitNote(text);
  return `Title: ${title || '(untitled)'}\nBody: ${body || '(empty)'}`;
}

function cacheKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCachedTags(text: string): string[] | null {
  const entry = store.cache.get(cacheKey(text));
  if (!entry || entry.expires < Date.now()) {
    if (entry) store.cache.delete(cacheKey(text));
    return null;
  }
  return entry.tags;
}

function setCachedTags(text: string, tags: string[]) {
  if (!tags.length) return;
  store.cache.set(cacheKey(text), { tags, expires: Date.now() + CACHE_TTL_MS });
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

  const clearlyPersonal =
    /\b(life balance|wellness|family|personal|journal|self[- ]?care|dog|cat|pet|pets|puppy|kitten|vet|vets|veterinar|groomer|pick up|pickup|birthday|gift|mom|dad|soccer|kids?)\b/.test(
      `${titleLower}\n${bodyLower}`,
    );
  const clearlyWork =
    /\b(meeting|meetings|sync|standup|work\b|client|quarterly|roadmap|interview|deadline|sprint|budget review)\b/.test(
      `${titleLower}\n${bodyLower}`,
    );

  let cleaned = [...tags];
  if (clearlyPersonal && !clearlyWork) {
    cleaned = cleaned.filter((tag) => tag !== 'work');
  } else if (clearlyWork && !clearlyPersonal) {
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
  if (/\b(life balance|wellness|personal|journal|family|hobby|dog|cat|pet|pets|vet|vets|groomer|pick up|pickup|birthday|gift|soccer)\b/.test(combined)) {
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

  const cached = getCachedTags(text);
  if (cached) return res.status(200).json({ tags: cached });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[api/tag] GEMINI_API_KEY is not set — AI tagging disabled, using keyword fallback only');
    const tags = fallbackTags(text);
    if (tags.length) {
      setCachedTags(text, tags);
      return res.status(200).json({ tags });
    }
    return res.status(503).json({ error: 'tagging unavailable' });
  }

  const ip = clientIp(req);
  const limited = rateLimited(ip);

  try {
    if (!limited) {
      const tags = await tagWithGemini(text.slice(0, MAX_TEXT_LENGTH), apiKey);
      setCachedTags(text, tags);
      return res.status(200).json({ tags });
    }
  } catch (error) {
    console.error('[api/tag] Gemini request failed', error);
  }

  const tags = fallbackTags(text);
  if (tags.length) {
    setCachedTags(text, tags);
    return res.status(200).json({ tags });
  }

  if (limited) {
    return res.status(429).json({ error: 'try again in a moment' });
  }

  return res.status(502).json({ error: 'tagging failed' });
}

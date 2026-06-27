const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const SITE_CONTEXT = `You are helping write blog posts for "Bux-Mont Hideaway," a warm personal family website based in Bucks County, Pennsylvania. The writing style should be friendly, genuine, and conversational — like a letter to a friend, not a formal article. Use simple, natural language.`;

function quickPostPrompt(notes) {
  return `${SITE_CONTEXT}

The author has written these notes about what they want to share:
---
${notes}
---

Write a short, warm personal post (2–4 paragraphs). Think of it like a Facebook post but slightly more polished. No headers, no bullet points — just flowing, friendly prose.

Respond with ONLY a JSON object in this exact format (no markdown fences):
{"title":"...","description":"...","body":"..."}

- title: a short, friendly title (5–8 words)
- description: one sentence summary (used as preview text)
- body: the full post in plain text paragraphs separated by two newlines`;
}

function eventStoryPrompt(notes, photoCount) {
  const photoNote = photoCount > 0
    ? `The author is including ${photoCount} photo(s) — a photo carousel will be added automatically after the text.`
    : '';
  return `${SITE_CONTEXT}

The author has written these notes about an event or experience they want to share:
---
${notes}
---
${photoNote}

Write a longer, warm personal story (5–8 paragraphs). Capture the feel of the day — the atmosphere, who was there, what happened, any funny or memorable moments, and a warm closing reflection. No headers, no bullet points — flowing prose only.

Respond with ONLY a JSON object in this exact format (no markdown fences):
{"title":"...","description":"...","body":"..."}

- title: a descriptive, friendly title (5–10 words)
- description: one or two sentence summary (used as preview text)
- body: the full story in plain text paragraphs separated by two newlines`;
}

export async function generateDraft(env, type, notes, photoCount) {
  const prompt = type === 'event'
    ? eventStoryPrompt(notes, photoCount)
    : quickPostPrompt(notes);

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text || '';

  // Parse the JSON response
  try {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: return raw as body with generic title
    return {
      title: 'New Post',
      description: '',
      body: raw,
    };
  }
}

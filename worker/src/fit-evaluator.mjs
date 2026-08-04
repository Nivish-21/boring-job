const API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const requestTimeoutMs = 30_000;

const buildMessages = (job, buckets) => {
  const bucketList = buckets
    .map((bucket) => `- id: ${bucket.id} | target_role: ${bucket.target_role} | positioning: ${bucket.positioning_angle}`)
    .join('\n');
  return [
    {
      role: 'system',
      content: 'You match a job posting to the single best-fitting resume bucket from a fixed list, or null if none fit well. Respond with JSON only: {"bucket_id": string|null, "confidence": number between 0 and 1, "reason": string}.'
    },
    {
      role: 'user',
      content: `Job title: ${job.title || 'unknown'}\nLocation: ${job.location || 'unknown'}\nDescription:\n${(job.description_text || '').slice(0, 4_000)}\n\nResume buckets:\n${bucketList}`
    }
  ];
};

export const classifyResumeBucket = async (job, buckets, { apiKey, fetchImpl = fetch, model = DEFAULT_MODEL } = {}) => {
  if (!apiKey) return { bucket_id: null, confidence: 0, reason: 'OpenAI API key is not configured' };
  if (!Array.isArray(buckets) || buckets.length === 0) return { bucket_id: null, confidence: 0, reason: 'No resume buckets available' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: buildMessages(job, buckets),
        response_format: { type: 'json_object' },
        temperature: 0
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorJson = await response.json().catch(() => null);
      return { bucket_id: null, confidence: 0, reason: errorJson?.error?.message || `OpenAI returned HTTP ${response.status}` };
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    const bucketId = typeof parsed.bucket_id === 'string' && buckets.some((bucket) => bucket.id === parsed.bucket_id) ? parsed.bucket_id : null;
    const confidence = typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
    return { bucket_id: bucketId, confidence, reason };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'OpenAI request timed out' : (error?.message || 'OpenAI request failed');
    return { bucket_id: null, confidence: 0, reason };
  } finally {
    clearTimeout(timeout);
  }
};

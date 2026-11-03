function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function reportedTokenCount(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) || number < 0 ? null : number;
}

export function estimateUsage(usage, rates) {
  const promptTokens = numberOrZero(usage?.promptTokenCount);
  const cachedTokens = Math.min(promptTokens, numberOrZero(usage?.cachedContentTokenCount));
  const inputTokens = Math.max(0, promptTokens - cachedTokens);
  const candidateTokens = numberOrZero(usage?.candidatesTokenCount);
  const thoughtsTokens = numberOrZero(usage?.thoughtsTokenCount);
  const outputTokens = candidateTokens + thoughtsTokens;
  const totalTokens = numberOrZero(usage?.totalTokenCount) || (promptTokens + outputTokens);
  const usd = (inputTokens * rates.input + cachedTokens * rates.cached + outputTokens * rates.output) / 1_000_000;

  return {
    usage: {
      inputTokens,
      cachedTokens,
      outputTokens,
      candidateTokens,
      thoughtsTokens,
      totalTokens,
      promptTokens,
      serviceTier: usage?.serviceTier || null,
      inputModalityDetails: usage?.promptTokensDetails || []
    },
    estimatedCost: {
      usd,
      currency: 'USD',
      tier: 'configured published-rate estimate',
      ratesPerMillion: { input: rates.input, cachedInput: rates.cached, outputIncludingThinking: rates.output }
    }
  };
}

export function captureResponseMetadata(response, rates) {
  const usageMetadata = response?.usageMetadata || {};
  const metrics = estimateUsage(usageMetadata, rates);
  const candidate = response?.candidates?.[0];

  return {
    diagnostics: {
      finishReason: candidate?.finishReason ?? null,
      finishMessage: candidate?.finishMessage ?? null,
      blockReason: response?.promptFeedback?.blockReason ?? null,
      promptTokenCount: reportedTokenCount(usageMetadata.promptTokenCount),
      candidatesTokenCount: reportedTokenCount(usageMetadata.candidatesTokenCount),
      thoughtsTokenCount: reportedTokenCount(usageMetadata.thoughtsTokenCount),
      totalTokenCount: reportedTokenCount(usageMetadata.totalTokenCount),
      rawResponseLength: 0
    },
    ...metrics
  };
}

export class GeminiResponseError extends Error {
  constructor(failureReason, message, captured, responseText = '') {
    super(message);
    this.name = 'GeminiResponseError';
    this.status = 502;
    this.failureReason = failureReason;
    this.diagnostics = captured.diagnostics;
    this.usage = captured.usage;
    this.estimatedCost = captured.estimatedCost;
    this.responseText = responseText;
  }
}

function extractText(response) {
  if (typeof response.text === 'string') return response.text;
  const parts = response.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
  return parts.map((part) => typeof part.text === 'string' ? part.text : '').join('');
}

function blockedResponse(captured) {
  const finishReason = String(captured.diagnostics.finishReason || '').toUpperCase();
  const blockReason = String(captured.diagnostics.blockReason || '').toUpperCase();
  const finishMessage = String(captured.diagnostics.finishMessage || '').toUpperCase();

  if (blockReason && blockReason !== 'BLOCKED_REASON_UNSPECIFIED') return true;
  if (['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'OTHER'].includes(finishReason)) return true;
  return Boolean(finishReason && !['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(finishReason));
}

export function parseGeminiResponse(response, captured) {
  let responseText;
  try {
    responseText = extractText(response);
  } catch {
    captured.diagnostics.rawResponseLength = 0;
    throw new GeminiResponseError('extraction_error', 'Could not extract text from the Gemini response.', captured);
  }

  captured.diagnostics.rawResponseLength = responseText.length;
  const finishReason = String(captured.diagnostics.finishReason || '').toUpperCase();
  const finishMessage = String(captured.diagnostics.finishMessage || '').toUpperCase();

  if (blockedResponse(captured)) {
    throw new GeminiResponseError('blocked_response', 'Gemini blocked the response.', captured, responseText);
  }
  if (finishReason === 'MAX_TOKENS' || finishMessage.includes('TRUNCAT')) {
    throw new GeminiResponseError('max_tokens', 'Gemini reached the output token limit; the response may be truncated.', captured, responseText);
  }
  if (!responseText.trim()) {
    throw new GeminiResponseError('empty_response', 'Gemini returned an empty response.', captured, responseText);
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new GeminiResponseError('malformed_json', 'Gemini returned a response that was not valid JSON.', captured, responseText);
  }
  if (!Array.isArray(parsed?.annotations)) {
    throw new GeminiResponseError('extraction_error', 'Gemini response is missing the annotations array.', captured, responseText);
  }
  return parsed;
}

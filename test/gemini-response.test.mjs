import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureResponseMetadata,
  GeminiResponseError,
  parseGeminiResponse
} from '../gemini-response.mjs';

const rates = { input: 0.75, cached: 0.075, output: 3.75 };
const validJson = JSON.stringify({ summary: 'ok', annotations: [] });

function response(overrides = {}) {
  return {
    text: validJson,
    candidates: [{ finishReason: 'STOP', finishMessage: 'done' }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 5,
      totalTokenCount: 135
    },
    ...overrides
  };
}

function assertFailure(result, reason) {
  assert.throws(result, (error) => {
    assert.ok(error instanceof GeminiResponseError);
    assert.equal(error.failureReason, reason);
    assert.equal(error.status, 502);
    return true;
  });
}

test('captures candidate, block, token, and raw response metadata', () => {
  const rawText = '{"summary":"ok","annotations":[]}';
  const result = response({
    text: rawText,
    candidates: [{ finishReason: 'STOP', finishMessage: 'complete' }],
    promptFeedback: { blockReason: 'BLOCKED_REASON_UNSPECIFIED' },
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 30,
      thoughtsTokenCount: 5,
      totalTokenCount: 135
    }
  });
  const captured = captureResponseMetadata(result, rates);

  assert.equal(captured.diagnostics.finishReason, 'STOP');
  assert.equal(captured.diagnostics.finishMessage, 'complete');
  assert.equal(captured.diagnostics.blockReason, 'BLOCKED_REASON_UNSPECIFIED');
  assert.equal(captured.diagnostics.promptTokenCount, 100);
  assert.equal(captured.diagnostics.candidatesTokenCount, 30);
  assert.equal(captured.diagnostics.thoughtsTokenCount, 5);
  assert.equal(captured.diagnostics.totalTokenCount, 135);
  assert.deepEqual(parseGeminiResponse(result, captured), { summary: 'ok', annotations: [] });
  assert.equal(captured.diagnostics.rawResponseLength, rawText.length);
  assert.ok(captured.estimatedCost.usd > 0);
});

test('classifies MAX_TOKENS and preserves the incomplete response and usage', () => {
  const rawText = '{"annotations":[{"label":"cut off';
  const result = response({
    text: rawText,
    candidates: [{ finishReason: 'MAX_TOKENS', finishMessage: 'Output was truncated' }]
  });
  const captured = captureResponseMetadata(result, rates);

  assertFailure(() => parseGeminiResponse(result, captured), 'max_tokens');
  assert.equal(captured.diagnostics.rawResponseLength, rawText.length);
  const error = (() => {
    try { parseGeminiResponse(result, captureResponseMetadata(result, rates)); }
    catch (caught) { return caught; }
  })();
  assert.equal(error.responseText, rawText);
  assert.equal(error.usage.totalTokens, 135);
  assert.ok(error.estimatedCost.usd > 0);
});

test('classifies truncation messages and retains malformed response diagnostics', () => {
  const truncated = response({
    text: '{"annotations":',
    candidates: [{ finishReason: 'STOP', finishMessage: 'The result was truncated.' }]
  });
  const truncatedError = (() => {
    try { parseGeminiResponse(truncated, captureResponseMetadata(truncated, rates)); }
    catch (error) { return error; }
  })();
  assert.equal(truncatedError.failureReason, 'max_tokens');
  assert.equal(truncatedError.responseText, '{"annotations":');

  const malformed = response({ text: '{"annotations":' });
  const malformedError = (() => {
    try { parseGeminiResponse(malformed, captureResponseMetadata(malformed, rates)); }
    catch (error) { return error; }
  })();
  assert.equal(malformedError.failureReason, 'malformed_json');
  assert.equal(malformedError.diagnostics.rawResponseLength, malformedError.responseText.length);
  assert.equal(malformedError.usage.totalTokens, 135);
  assert.ok(malformedError.estimatedCost.usd > 0);
});

test('classifies safety and other blocked responses before parsing', () => {
  const safety = response({ text: '', candidates: [{ finishReason: 'SAFETY' }] });
  assertFailure(() => parseGeminiResponse(safety, captureResponseMetadata(safety, rates)), 'blocked_response');

  const blocked = response({
    text: '',
    candidates: [{ finishReason: 'STOP' }],
    promptFeedback: { blockReason: 'BLOCKLIST' }
  });
  assertFailure(() => parseGeminiResponse(blocked, captureResponseMetadata(blocked, rates)), 'blocked_response');
});

test('distinguishes empty responses from malformed JSON', () => {
  const empty = response({ text: ' \n ' });
  assertFailure(() => parseGeminiResponse(empty, captureResponseMetadata(empty, rates)), 'empty_response');

  const malformed = response({ text: '{"annotations":' });
  assertFailure(() => parseGeminiResponse(malformed, captureResponseMetadata(malformed, rates)), 'malformed_json');
});

test('classifies valid JSON without annotations and text extraction exceptions', () => {
  const missingAnnotations = response({ text: '{"summary":"missing"}' });
  assertFailure(
    () => parseGeminiResponse(missingAnnotations, captureResponseMetadata(missingAnnotations, rates)),
    'extraction_error'
  );

  const extractionFailure = {
    get text() { throw new Error('private upstream detail'); },
    candidates: [{ finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 22, totalTokenCount: 22 }
  };
  const captured = captureResponseMetadata(extractionFailure, rates);
  assertFailure(() => parseGeminiResponse(extractionFailure, captured), 'extraction_error');
  assert.equal(captured.diagnostics.rawResponseLength, 0);
  assert.equal(captured.usage.promptTokens, 22);
});

test('extracts response text from candidate parts', () => {
  const result = {
    candidates: [{ content: { parts: [{ text: '{"summary":"parts",' }, { text: '"annotations":[]}' }] } }]
  };
  const captured = captureResponseMetadata(result, rates);

  assert.deepEqual(parseGeminiResponse(result, captured), { summary: 'parts', annotations: [] });
  assert.equal(captured.diagnostics.rawResponseLength, '{"summary":"parts","annotations":[]}'.length);
});

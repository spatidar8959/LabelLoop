import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { captureResponseMetadata, estimateUsage, parseGeminiResponse } from './gemini-response.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '4173', 10);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.GEMINI_API_KEY || '';
const MAX_OUTPUT_TOKENS = Number.parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || '16384', 10);
const MAX_BODY_BYTES = Number.parseInt(process.env.MAX_REQUEST_MB || '32', 10) * 1024 * 1024;
const MAX_CONCURRENT = Math.max(1, Number.parseInt(process.env.AI_MAX_CONCURRENCY || '2', 10));
const RATES = {
  input: Number.parseFloat(process.env.GEMINI_PRICE_INPUT_PER_M || '0.75'),
  cached: Number.parseFloat(process.env.GEMINI_PRICE_CACHED_PER_M || '0.075'),
  output: Number.parseFloat(process.env.GEMINI_PRICE_OUTPUT_PER_M || '3.75'),
};
const PROMPT_PATH = path.join(__dirname, 'prompts', 'annotation.prompt.md');
let activeRequests = 0;
let basePrompt = '';

try {
  basePrompt = await fs.readFile(PROMPT_PATH, 'utf8');
} catch (error) {
  console.error(`Could not read ${PROMPT_PATH}: ${error.message}`);
  process.exit(1);
}

const annotationSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A short summary of the annotation result.' },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['product', 'shelf', 'fixture', 'other'] },
          label: { type: 'string' },
          section: { type: 'string' },
          category: { type: 'string' },
          notes: { type: 'string' },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4,
            description: 'Normalized [ymin, xmin, ymax, xmax], each from 0 to 1000.'
          }
        },
        required: ['type', 'label', 'section', 'category', 'notes', 'box_2d']
      }
    }
  },
  required: ['summary', 'annotations']
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) { tooLarge = true; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error(`Request is too large. Limit: ${MAX_BODY_BYTES / 1024 / 1024} MB.`), { status: 413 }));
        return;
      }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function validateImage(image, label) {
  if (!image || typeof image !== 'object') throw Object.assign(new Error(`${label} image is missing.`), { status: 400 });
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) {
    throw Object.assign(new Error(`${label} must be JPEG, PNG or WebP.`), { status: 400 });
  }
  if (typeof image.data !== 'string' || image.data.length < 40) {
    throw Object.assign(new Error(`${label} image data is missing.`), { status: 400 });
  }
  if (!Number.isFinite(Number(image.width)) || !Number.isFinite(Number(image.height))) {
    throw Object.assign(new Error(`${label} image dimensions are invalid.`), { status: 400 });
  }
  // Base64 length is a useful pre-decode guard against accidental huge requests.
  if (image.data.length > MAX_BODY_BYTES) throw Object.assign(new Error(`${label} image exceeds the request limit.`), { status: 413 });
}

function imagePart(image) {
  return { inlineData: { mimeType: image.mimeType, data: image.data } };
}

function buildPrompt({ target, references, userInstructions, detail }) {
  const referenceDescriptions = references.map((reference, index) => {
    const annotations = reference.annotations.map((annotation, itemIndex) => ({
      example_no: itemIndex + 1,
      type: annotation.type || 'product',
      label: annotation.label || '',
      section: annotation.section || '',
      category: annotation.category || '',
      notes: annotation.notes || '',
      box_2d: annotation.box_2d
    }));
    return `REFERENCE EXAMPLE ${index + 1}: ${reference.image.name}\nImage dimensions before request resizing: ${reference.image.width}x${reference.image.height}.\nThe JSON below contains the manually reviewed annotations for this exact reference image:\n${JSON.stringify(annotations)}`;
  }).join('\n\n');

  return `${basePrompt.trim()}\n\nUSER-SPECIFIC INSTRUCTIONS (follow these unless they conflict with the output schema):\n${String(userInstructions || '').slice(0, 8000)}\n\nANNOTATION DETAIL MODE: ${detail || 'balanced'}. The image has been resized for transport, but all bounding boxes must be normalized to the full target image coordinate frame (0-1000), not pixel coordinates.\n\n${referenceDescriptions}\n\nTARGET IMAGE: ${target.name}\nOriginal dimensions: ${target.width}x${target.height}.\nAnalyze the following target image and return the complete annotations JSON. Reference annotations are examples of the desired annotation style, not objects that should be copied into the target. Do not assume the target has the same products or same number of positions.`;
}

async function handleAnnotate(req, res) {
  if (!API_KEY) return sendJson(res, 503, { error: 'GEMINI_API_KEY is not configured. Copy .env.example to .env and add your Gemini API key.' });
  if (activeRequests >= MAX_CONCURRENT) return sendJson(res, 429, { error: `The local AI server is handling ${MAX_CONCURRENT} requests. Try again shortly.` });
  activeRequests += 1;
  const started = performance.now();
  let responseMetrics = null;
  let responseModel = MODEL;
  let geminiRequestStarted = false;
  try {
    const payload = await readJson(req);
    validateImage(payload.target, 'Target');
    if (!Array.isArray(payload.references) || payload.references.length < 1 || payload.references.length > 2) {
      throw Object.assign(new Error('Select one or two annotated reference examples.'), { status: 400 });
    }
    for (const reference of payload.references) {
      validateImage(reference.image, 'Reference');
      if (!Array.isArray(reference.annotations) || reference.annotations.length === 0) {
        throw Object.assign(new Error(`Reference ${reference.image.name || ''} has no annotations.`), { status: 400 });
      }
    }
    const parts = [{ text: buildPrompt(payload) }];
    payload.references.forEach((reference, index) => {
      parts.push({ text: `Reference image ${index + 1}: ${reference.image.name}. Inspect its manually drawn bounding boxes and use its annotations as examples.` });
      parts.push(imagePart(reference.image));
    });
    parts.push({ text: `Now annotate this target image only: ${payload.target.name}.` });
    parts.push(imagePart(payload.target));

    const ai = new GoogleGenAI({ apiKey: API_KEY });
    geminiRequestStarted = true;
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts }],
      config: {
        responseMimeType: 'application/json',
        responseJsonSchema: annotationSchema,
        maxOutputTokens: MAX_OUTPUT_TOKENS
      }
    });

    responseModel = response.modelVersion || MODEL;
    responseMetrics = captureResponseMetadata(response, RATES);
    const parsed = parseGeminiResponse(response, responseMetrics);
    sendJson(res, 200, {
      annotations: parsed.annotations,
      summary: String(parsed.summary || ''),
      model: responseModel,
      latencyMs: Math.round(performance.now() - started),
      promptVersion: 'annotation.prompt.md',
      usage: responseMetrics.usage,
      estimatedCost: responseMetrics.estimatedCost
    });
  } catch (error) {
    const status = Number(error.status) || 500;
    const isResponseError = typeof error.failureReason === 'string';
    const payload = {
      error: isResponseError ? error.message : (status >= 500 || geminiRequestStarted ? 'Gemini request failed. Check the server configuration and try again.' : error.message),
      latencyMs: Math.round(performance.now() - started),
      model: responseModel,
      usage: error.usage || responseMetrics?.usage || estimateUsage({}, RATES).usage,
      estimatedCost: error.estimatedCost || responseMetrics?.estimatedCost || estimateUsage({}, RATES).estimatedCost
    };
    if (isResponseError) {
      payload.failureReason = error.failureReason;
      payload.diagnostics = error.diagnostics;
      payload.responseText = error.responseText;
    }
    sendJson(res, status, payload);
  } finally {
    activeRequests -= 1;
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8'
};

async function serveStatic(urlPath, res) {
  const requested = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  if (!['/index.html', '/favicon.ico'].includes(requested)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return;
  }
  const filePath = path.resolve(__dirname, `.${requested}`);
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const origin = req.headers.origin;
  const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
  if (origin && !allowedOrigins.has(origin)) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed by the local ShelfScope server.' });
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(res, 200, {
      configured: Boolean(API_KEY), model: MODEL, maxConcurrent: MAX_CONCURRENT,
      pricing: { inputPerMillion: RATES.input, cachedInputPerMillion: RATES.cached, outputPerMillion: RATES.output },
      note: 'Estimated paid-tier list price. Actual billing depends on your Gemini API tier and account.'
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/annotate') return handleAnnotate(req, res);
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`ShelfScope running at http://${HOST}:${PORT}`);
  console.log(`Gemini model: ${MODEL}; API key: ${API_KEY ? 'configured' : 'missing'}`);
  console.log(`AI concurrency: ${MAX_CONCURRENT}; estimated paid rates (USD/1M): input ${RATES.input}, cached ${RATES.cached}, output ${RATES.output}`);
});

# LabelLoop

## ShelfScope — Visual Dataset Studio

A local-first image annotation workspace for shelf/rack datasets, with optional Gemini-assisted annotation. The browser UI remains plain HTML/CSS/JavaScript. A small Node.js server protects the Gemini API key and makes calls through Google's official `@google/genai` SDK.

## Requirements

- Node.js 20 or later
- A Gemini API key from Google AI Studio / Gemini API
- Internet access for Gemini requests

## Run locally

1. Open a terminal in this folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Create your local environment file:

   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your `GEMINI_API_KEY`. Keep `.env` private and never commit it.
5. Start ShelfScope:

   ```bash
   npm start
   ```

6. Open <http://127.0.0.1:4173> in Safari or Chrome.

Do not open `index.html` directly with `file://` when using AI annotation. The Node server serves the page and handles Gemini requests.

## AI annotation workflow

1. Load your image files or a folder.
2. Manually annotate one or two representative images.
3. While each reference image is active, click **Use as AI example**. A reference must contain at least one manually drawn box. You can select up to two examples.
4. Click **Annotate with AI**.
5. Add optional instructions. Choose Economy, Balanced or High detail.
6. By default, AI processes images that do not already contain annotations. Enable the replace checkbox only when you intentionally want to replace existing boxes.
7. Start the run. The browser processes up to two target images at a time and displays progress.
8. Review AI drafts, adjust boxes/labels, and click **Mark done** on each image when satisfied.
9. Export the dataset. The JSON records original-image-normalized boxes as `[ymin, xmin, ymax, xmax]` in the 0–1000 range. Usage data is included.

## Image detail presets

- Economy: resize to a maximum 1024 px long edge and JPEG quality 0.78.
- Balanced: maximum 1600 px and quality 0.86.
- High detail: maximum 2560 px and quality 0.90.

These presets control the image sent to Gemini. Bounding boxes remain normalized to the complete original image. Higher detail can improve small-object visibility but can increase token usage. Validate the trade-off on your own dataset.

## Prompts and model settings

- Base annotation prompt: `prompts/annotation.prompt.md`.
- Model and pricing rates: `.env`.
- User-specific instructions: entered in the AI annotation dialog and sent with each request.

Restart the server after changing `.env` or `prompts/annotation.prompt.md`.

## Usage and cost

Gemini's response usage metadata is used to display prompt/input tokens, cached tokens, candidate output tokens, thinking tokens, total tokens, latency and an estimated USD cost. The estimate uses the configured rates in `.env`; it is not an invoice and can differ from actual billing, especially on free, batch, flex or priority tiers. Update the rates when your account tier or Google's prices change.

Failed Gemini responses are also recorded when usage metadata is available. The AI usage history includes the failure reason and expandable response diagnostics, including incomplete response text, so token-limit and blocked-response issues can be inspected.

## Privacy and security

- The API key is read by Node.js from `.env`; it is never sent to the browser.
- The server binds to `127.0.0.1` by default and is intended for local use.
- Only the selected reference images and target images are uploaded to Gemini.
- Annotation workspaces are stored locally in browser IndexedDB until exported.
- AI usage history is saved in the local workspace and exported in `annotations.json`.

Do not expose this local server to a network without adding proper authentication, request limits and deployment security.

import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
if (fs.existsSync(".env.local")) {
  dotenv.config({ path: ".env.local", override: true });
}

const app = express();

/* Simple CORS so Bubble can call your API */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
const upload = multer({ dest: "uploads/" });

let openaiClient = null;

function getApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI_TOKEN ||
    ""
  ).trim();
}

function getOpenAI() {
  const key = getApiKey();
  if (!key) return null;
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: key });
  return openaiClient;
}

app.get("/health", (req, res) => {
  const key = getApiKey();
  res.json({
    ok: true,
    hasKey: Boolean(key),
    keyPreview: key ? `${key.slice(0, 7)}...${key.slice(-4)}` : null,
    debug: process.env.DEBUG_VERO === "1",
    envLocalLoaded: fs.existsSync(".env.local"),
  });
});

function pickOutputText(resp) {
  if (!resp) return null;

  if (typeof resp.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text;
  }

  const out = resp.output;
  if (Array.isArray(out)) {
    const flat = out.flatMap((o) => (Array.isArray(o.content) ? o.content : []));
    const txt = flat.find(
      (c) => c.type === "output_text" && typeof c.text === "string"
    )?.text;
    if (txt && txt.trim()) return txt;
  }

  return null;
}

function safeJsonParse(text) {
  if (!text) return null;
  const trimmed = String(text).trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

app.post("/detect", upload.single("image"), async (req, res) => {
  let filePath;

  const startedAt = Date.now();
  const request_id = `vero_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    if (!req.file) {
      return res.status(400).json({
        result: "Not Detectable By Vero",
        confidence: 0,
        why: "No image file was provided.",
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    const openai = getOpenAI();
    if (!openai) {
      return res.status(500).json({
        result: "Not Detectable By Vero",
        confidence: 0,
        why: "Server is missing OPENAI_API_KEY (check .env.local or Render env vars).",
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    const allowed = new Set([
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
    ]);
    if (!allowed.has((req.file.mimetype || "").toLowerCase())) {
      return res.status(400).json({
        result: "Not Detectable By Vero",
        confidence: 0,
        why: `Unsupported image type: ${req.file.mimetype}. Use jpg, jpeg, png, gif, or webp.`,
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    filePath = req.file.path;
    const imageBuffer = fs.readFileSync(filePath);
    const imageBase64 = imageBuffer.toString("base64");
    const mimeType = (req.file.mimetype || "").toLowerCase();

    const prompt = `You are an AI image forensics system.

Classify the image as ONE of:
- AI Generated
- Manipulated
- Real Photograph

Evaluate lighting, textures, edges, distortions, and generative artifacts.

Respond ONLY in JSON:
{
  "classification": "AI Generated | Manipulated | Real Photograph",
  "confidence_raw": number between 0 and 100,
  "reason": "1 short sentence explanation"
}`;

    let parsed;

    const useResponsesApi =
      openai?.responses?.create && typeof openai.responses.create === "function";

    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

    if (useResponsesApi) {
      const resp = await openai.responses.create({
        model: "gpt-4o",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
        temperature: 0,
      });

      const textOutput = pickOutputText(resp);
      if (!textOutput) throw new Error("OpenAI returned no text output");

      parsed = safeJsonParse(textOutput);
      if (!parsed) throw new Error("Model returned non JSON output");
    } else {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0,
      });

      const textOutput = resp?.choices?.[0]?.message?.content;
      if (!textOutput) throw new Error("OpenAI returned no message content");

      parsed = safeJsonParse(textOutput);
      if (!parsed) throw new Error("Model returned non JSON output");
    }

    const confidence = Number(parsed.confidence_raw) || 0;

    let result = "Not Detectable By Vero";
    if (confidence >= 70) {
      if (parsed.classification === "AI Generated") result = "AI Detected by Vero";
      else if (parsed.classification === "Manipulated")
        result = "Manipulation Detected by Vero";
      else if (parsed.classification === "Real Photograph")
        result = "Verified by Vero";
      else result = "Not Detectable By Vero";
    }

    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    return res.json({
      result,
      confidence,
      why:
        confidence < 70
          ? "Not Detectable By Vero (confidence under 70%)."
          : String(
              parsed.reason ||
                "Vero detected strong visual signals consistent with this classification."
            ).slice(0, 200),
      request_id,
      processing_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err?.message ? String(err.message) : "Unknown error";
    const status = err?.status || err?.response?.status || null;

    console.error("VERO ERROR:", msg, status ? `status=${status}` : "");

    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const base = {
      result: "Not Detectable By Vero",
      confidence: 0,
      why: "An internal error occurred during analysis.",
      request_id,
      processing_ms: Date.now() - startedAt,
    };

    if (process.env.DEBUG_VERO === "1") {
      return res.status(500).json({
        ...base,
        debug: {
          message: msg,
          status,
        },
      });
    }

    return res.status(500).json(base);
  }
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vero backend running on port ${PORT}`);
  console.log("Routes: GET /health, POST /detect");
});

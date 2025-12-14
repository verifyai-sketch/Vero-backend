// index.js (ESM, Railway ready)

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

const allowed = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

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

app.get("/", (req, res) => {
  res.json({ ok: true, service: "vero-backend", routes: ["/health", "/detect"] });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    debug: process.env.DEBUG_VERO === "1",
  });
});

app.post("/detect", upload.single("image"), async (req, res) => {
  const startedAt = Date.now();
  const request_id = `vero_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    if (!req.file) {
      return res.status(400).json({
        result: "Inconclusive",
        confidence: 0,
        why: "No image file was provided, send form-data key named image.",
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        result: "Inconclusive",
        confidence: 0,
        why: "Server is missing OPENAI_API_KEY.",
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    if (!allowed.has(req.file.mimetype)) {
      return res.status(400).json({
        result: "Inconclusive",
        confidence: 0,
        why: `Unsupported image type: ${req.file.mimetype}. Use jpg, jpeg, png, gif, or webp.`,
        request_id,
        processing_ms: Date.now() - startedAt,
      });
    }

    const imageBase64 = req.file.buffer.toString("base64");
    const mimeType = req.file.mimetype;
    const dataUrl = `data:${mimeType};base64,${imageBase64}`;

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

    let parsed = null;

    const useResponsesApi =
      openai?.responses?.create && typeof openai.responses.create === "function";

    if (useResponsesApi) {
      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: dataUrl },
            ],
          },
        ],
      });

      const textOutput = pickOutputText(resp);
      if (!textOutput) throw new Error("OpenAI returned no text output");

      parsed = JSON.parse(textOutput);
    } else {
      const resp = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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

      parsed = JSON.parse(textOutput);
    }

    const confidence = Number(parsed?.confidence_raw) || 0;

    let result = "Inconclusive";
    if (confidence >= 70) {
      if (parsed.classification === "AI Generated") result = "AI Detected by Vero";
      else if (parsed.classification === "Manipulated")
        result = "Manipulation Detected by Vero";
      else if (parsed.classification === "Real Photograph") result = "Verified by Vero";
      else result = "Inconclusive";
    }

    return res.json({
      result,
      confidence,
      why:
        confidence < 70
          ? "The image lacks strong, decisive signals required for a confident determination."
          : String(
              parsed?.reason ||
                "Vero detected strong visual signals consistent with this classification."
            ).slice(0, 200),
      request_id,
      processing_ms: Date.now() - startedAt,
    });
  } catch (err) {
    const msg = err?.message ? String(err.message) : "Unknown error";
    const status = err?.status || err?.response?.status || null;

    console.error("VERO ERROR:", msg, status ? `status=${status}` : "");

    const base = {
      result: "Inconclusive",
      confidence: 0,
      why: "An internal error occurred during analysis.",
      request_id,
      processing_ms: Date.now() - startedAt,
    };

    if (process.env.DEBUG_VERO === "1") {
      return res.status(500).json({
        ...base,
        debug: { message: msg, status },
      });
    }

    return res.status(500).json(base);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Vero backend running on port ${PORT}`);
  console.log("Routes, GET /health, POST /detect");
});

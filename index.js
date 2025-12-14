// ==============================
// ENV SETUP (ES MODULE SAFE)
// ==============================
import dotenv from "dotenv";

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.local" });
}

// ==============================
// IMPORTS
// ==============================
import express from "express";
import multer from "multer";
import fs from "fs";
import OpenAI from "openai";

// ==============================
// APP SETUP
// ==============================
const app = express();
app.use(express.json());

// ==============================
// OPENAI CLIENT
// ==============================
if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is missing or empty");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ==============================
// FILE UPLOAD SETUP
// ==============================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ==============================
// HEALTH CHECK
// ==============================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    debug: process.env.NODE_ENV !== "production"
  });
});

// ==============================
// DETECT ROUTE
// ==============================
app.post("/detect", upload.single("image"), async (req, res) => {
  const requestId = `vero_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No image file provided",
        request_id: requestId
      });
    }

    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an AI forensic analyst. Determine if the image is AI-generated, manipulated, or a real photograph."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this image." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            }
          ]
        }
      ]
    });

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      result: response.choices[0].message.content,
      request_id: requestId
    });
  } catch (error) {
    console.error("VERO ERROR:", error);

    res.status(500).json({
      success: false,
      error: "Internal error during analysis",
      request_id: requestId
    });
  }
});

// ==============================
// ROOT
// ==============================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "vero-backend",
    routes: ["/health", "/detect"]
  });
});

// ==============================
// SERVER START
// ==============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Vero backend running on port ${PORT}`);
  console.log("Routes: GET /health, POST /detect");
});

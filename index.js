const express = require("express");
const axios = require("axios");
const stringSimilarity = require("string-similarity");
const { readPdfFromUrl } = require("./util");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── OpenAI client ─────────────────────────────────────────────────────────
const openai = axios.create({
  baseURL: "https://dev-api.healthrx.co.in/sp-gw/api/openai/v1",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPEN_AI_KEY}`,
  },
  timeout: 60000,
});

// ─── In‑memory cache for chunk embeddings per document URL ────────────────
const embedCache = new Map();

/**
 * Embed text (with fallback to string-sim if embeddings fail)
 */
async function getEmbeddings(texts) {
  try {
    const resp = await openai.post("/embeddings", {
      model: "gpt-4o",
      input: texts,
    });
    return resp.data.data.map((d) => d.embedding);
  } catch {
    // fallback: return empty arrays; we'll use string-similarity later
    return texts.map(() => null);
  }
}

app.post("/hackrx/run", async (req, res) => {
  const { documents, questions } = req.body;
  if (!documents || !Array.isArray(questions)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    // 1) Load PDF text once
    const fullText = (await readPdfFromUrl(documents)).text;

    // 2) Chunk the document
    const CHUNK_SIZE = 20_000;
    const chunks = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    }

    // 3) Retrieve or compute chunk embeddings
    let chunkEmbs = embedCache.get(documents);
    if (!chunkEmbs) {
      chunkEmbs = await getEmbeddings(chunks);
      embedCache.set(documents, chunkEmbs);
    }

    // 4) For each question, pick top‑3 contexts
    const items = await Promise.all(
      questions.map(async (q, idx) => {
        const question = q.trim();
        if (!question) return { ques: idx, context: "", question };

        // Try embedding question
        let qEmb;
        try {
          const [e] = await getEmbeddings([question]);
          qEmb = e;
        } catch {
          qEmb = null;
        }

        // Score chunks
        const scored = chunks.map((txt, i) => {
          let score = 0;
          if (qEmb && chunkEmbs[i]) {
            // cosine similarity
            const dot = qEmb.reduce((sum, v, j) => sum + v * chunkEmbs[i][j], 0);
            const magA = Math.sqrt(qEmb.reduce((s, v) => s + v * v, 0));
            const magB = Math.sqrt(chunkEmbs[i].reduce((s, v) => s + v * v, 0));
            score = dot / (magA * magB);
          } else {
            // fallback to string-similarity
            score = stringSimilarity.compareTwoStrings(question, txt);
          }
          return { idx: i, score, text: txt };
        });

        scored.sort((a, b) => b.score - a.score);
        const top3 = scored.slice(0, 3).map((c) => c.text).join("\n\n---\n\n");

        return { ques: idx, question, context: top3 };
      })
    );

    // 5) Single ChatCompletion for *all* questions
    const systemPrompt = [
      "You are a precise document QA assistant.",
      "You will receive an array of {ques, question, context} objects.",
      "For each, answer in JSON array form ONLY:",
      `{"answers":[{"ques":<number>,"ans":"<string>"}]}`,
      '- If answer is NOT in the context, ans must be exactly "Not available in document.".',
      "No backticks or extra text.",
    ].join(" ");

    const userPayload = { items };

    const chatResp = await openai.post("/chat/completions", {
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ],
      temperature: 0,
      max_tokens: 2000,
    });

    // 6) Extract JSON block
    let raw = chatResp.data.choices[0].message.content.trim();
    const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error("Model output missing JSON");
    }
    raw = raw.slice(start, end + 1);

    const parsed = JSON.parse(raw);
    // 7) Build answers array in question order
    const answers = [];
    for (const { ques, ans } of parsed.answers || []) {
      answers[ques] = ans;
    }

    return res.json({ answers });
  } catch (err) {
    console.error("Error in /hackrx/run:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(3030, () => {
  console.log("Listening on port 3030");
});

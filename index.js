const express = require("express");
const app = express();
const axios = require("axios");
const stringSimilarity = require("string-similarity");
const { readPdfFromUrl } = require("./util");
require("dotenv").config();

const openai = axios.create({
  baseURL: "https://dev-api.healthrx.co.in/sp-gw/api/openai/v1",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPEN_AI_KEY}`,
  },
  timeout: 30_000, // Reduced timeout to avoid hanging
});

// Middleware
app.use(express.json({ limit: "10mb" })); // Limit payload size
app.use(express.urlencoded({ extended: true }));

// Retry logic for API calls
const retry = async (fn, retries = 3, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

app.post("/hackrx/run", async (req, res) => {
  const { documents, questions } = req.body;
  if (!documents || !Array.isArray(questions) || questions.length > 50) {
    return res.status(400).json({ error: "Invalid payload or too many questions" });
  }

  try {
    // 1) Read PDF with timeout
    let fullText;
    try {
      const pdfResult = await Promise.race([
        readPdfFromUrl(documents),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("PDF read timeout")), 15_000)
        ),
      ]);
      fullText = pdfResult.text;
    } catch (err) {
      console.error("PDF read error:", err.message);
      return res.status(500).json({ error: "Failed to process PDF" });
    }

    // 2) Split into smaller chunks for efficiency
    const CHUNK_SIZE = 10_000; // Reduced chunk size
    const chunks = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    }
    if (chunks.length > 100) {
      return res.status(400).json({ error: "Document too large" });
    }

    // 3) Process questions in batches
    const BATCH_SIZE = 5;
    const answers = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      const batch = questions.slice(i, i + BATCH_SIZE).map((q, idx) => ({
        question: q,
        index: i + idx,
      }));

      const batchAnswers = await Promise.all(
        batch.map(async ({ question, index }) => {
          if (!question.trim()) return { index, answer: "" };

          // Score chunks for similarity
          const scores = chunks.map((txt, i) => ({
            idx: i,
            score: stringSimilarity.compareTwoStrings(question, txt.slice(0, 2000)), // Limit chunk size for scoring
            text: txt,
          }));
          scores.sort((a, b) => b.score - a.score);
          const context = scores.slice(0, 3).map((c) => c.text).join("\n\n---\n\n");

          // Build prompt
          const messages = [
            {
              role: "system",
              content: [
                "You are a precise document QA assistant.",
                "Given a document excerpt and a question, respond ONLY with valid JSON:",
                `{"ans":"<string>"}`,
                "- If you cannot find the answer in the excerpt, return exactly \"Not available in document.\"",
                "No code fences or extra text.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({
                excerpt: context.slice(0, 15_000), // Limit context size
                question,
              }),
            },
          ];

          // API call with retry
          let resp;
          try {
            resp = await retry(() =>
              openai.post("/chat/completions", {
                model: "gpt-4o",
                messages,
                temperature: 0,
                max_tokens: 500,
              })
            );
          } catch (err) {
            console.error("ChatCompletion error for Q#", index, err.message);
            return { index, answer: "" };
          }

          // Extract JSON
          let out = resp.data.choices[0].message.content.trim();
          const b1 = out.indexOf("{");
          const b2 = out.lastIndexOf("}");
          if (b1 === -1 || b2 === -1) return { index, answer: "" };
          out = out.slice(b1, b2 + 1);

          try {
            const obj = JSON.parse(out);
            return { index, answer: obj.ans || "" };
          } catch {
            return { index, answer: "" };
          }
        })
      );

      // Sort answers by index to maintain order
      batchAnswers.sort((a, b) => a.index - b.index);
      answers.push(...batchAnswers.map((a) => a.answer));
    }

    return res.json({ answers });
  } catch (err) {
    console.error("Fatal error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Use Render's assigned port
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
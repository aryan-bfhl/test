const express = require("express");
const app = express();
const axios = require("axios");
const cosine = require("fast-cosine-similarity");
const { readPdfFromUrl } = require("./util");
require("dotenv").config();

const openai = axios.create({
  baseURL: "https://dev-api.healthrx.co.in/sp-gw/api/openai/v1",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPEN_AI_KEY}`,
  },
  timeout: 60_000,
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const stringSimilarity = require("string-similarity");

app.post("/hackrx/run", async (req, res) => {
  const { documents, questions } = req.body;
  if (!documents || !Array.isArray(questions)) {
    return res.status(400).json({ error: "Invalid payload" });
  }

  try {
    // 1) Get the full text
    const fullText = (await readPdfFromUrl(documents)).text;

    // 2) Split into fixed-size chunks
    const CHUNK_SIZE = 20_000;
    const chunks = [];
    for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + CHUNK_SIZE));
    }

    // 3) For each question: pick top 3 similar chunks & ask once
    const answers = await Promise.all(
      questions.map(async (q, idx) => {
        if (!q.trim()) return "";

        // score each chunk on the question
        const scores = chunks.map((txt, i) => ({
          idx: i,
          score: stringSimilarity.compareTwoStrings(q, txt),
          text: txt,
        }));
        // pick top 3
        scores.sort((a, b) => b.score - a.score);
        const context = scores.slice(0, 3).map((c) => c.text).join("\n\n---\n\n");

        // build prompt
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
              excerpt: context,
              question: q,
            }),
          },
        ];

        // single ChatCompletion call
        let resp;
        try {
          resp = await openai.post("/chat/completions", {
            model: "gpt-4o",
            messages,
            temperature: 0,
            max_tokens: 500,
          });
        } catch (err) {
          console.error("ChatCompletion error for Q#", idx, err.response?.data || err.message);
          return "";
        }

        // extract the JSON
        let out = resp.data.choices[0].message.content.trim();
        const b1 = out.indexOf("{");
        const b2 = out.lastIndexOf("}");
        if (b1 === -1 || b2 === -1) return "";
        out = out.slice(b1, b2 + 1);

        try {
          const obj = JSON.parse(out);
          return obj.ans || "";
        } catch {
          return "";
        }
      })
    );

    return res.json({ answers });
  } catch (err) {
    console.error("Fatal error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


app.listen(3030, () => {
  console.log("Listening on port 3030");
});

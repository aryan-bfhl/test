const express = require("express");
const app = express();
const axios = require("axios");
const { readPdfFromUrl } = require("./util");
require("dotenv").config();

const openai = axios.create({
  baseURL: "https://dev-api.healthrx.co.in/sp-gw/api/openai/v1",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.OPEN_AI_KEY}`,
  },
  timeout: 30000, // 30s
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Hi");
});

app.post("/hackrx/run", async (req, res) => {
    const { documents, questions } = req.body;
    if (!documents || !Array.isArray(questions)) {
      return res.status(400).json({ error: "Invalid payload" });
    }
  
    try {
      const fullText = (await readPdfFromUrl(documents)).text;
  
      const CHUNK_SIZE = 50_000;
      const CHUNK_OVERLAP = 1_000;
      const answers = [];
      const answered = new Set();
  
      for (
        let offset = 0;
        offset < fullText.length && questions.some((q) => q.trim() !== "");
        offset += CHUNK_SIZE - CHUNK_OVERLAP
      ) {
        const chunk = fullText.substring(offset, offset + CHUNK_SIZE);
        const pending = questions
          .map((q, idx) => ({ q: q.trim(), idx }))
          .filter(({ q }) => q !== "");
        if (pending.length === 0) break;
  
        // Tighten prompt: forbid fences/backticks
        const messages = [
          {
            role: "system",
            content: [
              "You are a precise document QA assistant.",
              "You will be given a chunk of text and a list of numbered questions.",
              "You MUST output valid JSON NOTHING ELSE — no backticks, no code fences.",
              "Use this EXACT schema: {\"answers\":[{\"ques\":<number>,\"ans\":\"<string>\"},…]}",
              "For each question:",
              "- If the answer is in the text, return it verbatim (shortest span).",
              "- Otherwise, return exactly: \"Not available in document.\"",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              text: chunk,
              questions: pending.map(({ idx, q }) => ({ ques: idx, question: q })),
            }),
          },
        ];
  
        let resp;
        try {
          resp = await openai.post("/chat/completions", {
            model: "gpt-4o",
            messages,
            temperature: 0,
            max_tokens: 2000,
            stop: null,
          });
        } catch (err) {
          console.error("OpenAI request error:", err.response?.data || err.message);
          continue;
        }
  
        // ==== Robust JSON extraction ====
        let raw = resp.data.choices[0].message.content || "";
        raw = raw.trim();
  
        // strip any leading/trailing fences/backticks/text
        const firstBrace = raw.indexOf("{");
        const lastBrace = raw.lastIndexOf("}");
        if (firstBrace === -1 || lastBrace === -1) {
          console.error("No JSON braces found in model output:", raw);
          continue;
        }
        const jsonText = raw.substring(firstBrace, lastBrace + 1);
  
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch (err) {
          console.error("JSON.parse failed on:", jsonText, err.message);
          continue;
        }
  
        // integrate answers
        for (const { ques, ans } of Array.isArray(parsed.answers) ? parsed.answers : []) {
          if (
            typeof ques === "number" &&
            typeof ans === "string" &&
            ans !== "Not available in document." &&
            !answered.has(ques)
          ) {
            answers[ques] = ans;
            questions[ques] = "";
            answered.add(ques);
          }
        }
      }
  
      return res.json({ answers });
    } catch (err) {
      console.error("Fatal error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
  

app.listen(3030, () => {
  console.log("Listening on port 3030");
});

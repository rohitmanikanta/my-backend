import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors()); // tighten in production
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --------------- Helpers -----------------

/**
 * Try to extract a JSON string from a text response.
 * Handles ```json ... ``` fences and raw JSON blobs.
 */
function extractJson(text) {
  if (!text) return null;

  // ```json ... ```
  const fenced = text.match(/```json([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  // generic ``` ... ```
  const genericFenced = text.match(/```([\s\S]*?)```/);
  if (genericFenced) return genericFenced[1].trim();

  // fallback: attempt to slice between first { and last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1).trim();
  }

  return null;
}

/**
 * Convert the parsed JSON into a human-readable, plain-text message (no **bold**).
 */
function formatMedicineData(data) {
  let message = `${data.name || 'Unknown medicine'}\n\n`;

  if (Array.isArray(data.uses) && data.uses.length) {
    message += 'Uses:\n';
    for (const u of data.uses) {
      if (typeof u === 'string') {
        message += `- ${u}\n`;
      } else if (u && typeof u === 'object') {
        // supports { condition, description } style too
        const line = [u.condition, u.description].filter(Boolean).join(': ');
        message += `- ${line || JSON.stringify(u)}\n`;
      }
    }
    message += '\n';
  }

  if (Array.isArray(data.sideEffects) && data.sideEffects.length) {
    message += 'Side Effects:\n';
    for (const group of data.sideEffects) {
      if (typeof group === 'string') {
        message += `- ${group}\n\n`;
        continue;
      }

      const sev = group.severity || 'Severity not specified';
      message += `- ${sev}:\n`;
      if (Array.isArray(group.effects)) {
        for (const effect of group.effects) {
          message += `  - ${effect}\n`;
        }
      }
      message += '\n';
    }
  }

  if (data.note) {
    message += `Note:\n${data.note}\n`;
  } else {
    message += 'Note:\nThis information is for educational purposes only. Always consult a qualified healthcare professional.\n';
  }

  return message.trim();
}

// --------------- Routes -----------------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/ai', async (req, res) => {
  const { query } = req.body ?? {};
  if (!query) {
    return res.status(400).json({ error: 'query is required' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const prompt = `
Return ONLY valid JSON for the medicine "${query}" using EXACTLY this schema:

{
  "name": "string",
  "uses": ["string", "string", ...],
  "sideEffects": [
    { "severity": "Common (affecting more than 1 in 100 people)", "effects": ["string", "string"] },
    { "severity": "Uncommon (affecting 1 to 10 in 1000 people)", "effects": ["string", "string"] },
    { "severity": "Rare (affecting 1 to 10 in 10,000 people)", "effects": ["string", "string"] },
    { "severity": "Very Rare (affecting less than 1 in 10,000 people)", "effects": ["string", "string"] },
    { "severity": "Other potential side effects", "effects": ["string", "string"] },
    { "severity": "Overdose side effects", "effects": ["string", "string"] }
  ],
  "note": "string"
}

Do not add any commentary outside JSON. Do not wrap it in Markdown unless it's a JSON code fence.
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const rawText = response.text() || '';

    let parsed = null;
    let formattedText = rawText;

    try {
      const jsonString = extractJson(rawText) ?? rawText;
      parsed = JSON.parse(jsonString);
      formattedText = formatMedicineData(parsed);
    } catch (err) {
      console.warn('Could not parse JSON from Gemini, returning raw text.');
    }

    return res.json({
      text: formattedText, // human-friendly plain text (no **)
      raw: parsed,         // original parsed JSON if you need it in the UI
    });
  } catch (err) {
    console.error('Gemini Error:', err);
    return res.status(500).json({ error: 'Gemini AI request failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const officeParser = require('officeparser');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper to determine mime type for images
function getMimeType(extension) {
    if (extension === '.png') return 'image/png';
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.webp') return 'image/webp';
    if (extension === '.heic') return 'image/heic';
    if (extension === '.heif') return 'image/heif';
    return 'image/jpeg';
}

// Call Gemini API with automatic exponential backoff retry for 503 / 429 / transient spikes
async function callGeminiWithRetry(contents, maxRetries = 4) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await ai.models.generateContent({
                model: 'gemini-3.6-flash',
                contents: contents,
            });
            return response;
        } catch (err) {
            lastError = err;
            const status = err.status || (err.error && err.error.code);
            const isTransient = status === 503 || status === 429 || status === 500 || status === 502 || status === 504 ||
                /high demand|UNAVAILABLE|RESOURCE_EXHAUSTED|rate limit|overloaded|fetch failed/i.test(err.message || '');

            if (isTransient && attempt < maxRetries) {
                // Exponential backoff: ~2s, ~4s, ~8s with random jitter
                const delayMs = (2 ** (attempt - 1)) * 2000 + Math.floor(Math.random() * 1000);
                console.warn(`⚠️ [AI Service] Gemini model temporary spike/unavailable (Code ${status}). Retrying in ${(delayMs / 1000).toFixed(1)}s (Attempt ${attempt}/${maxRetries})…`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
                throw err;
            }
        }
    }

    throw lastError;
}

async function processMaterialWithAI(filePath, db, materialId) {
    if (!process.env.GEMINI_API_KEY) {
        console.warn("GEMINI_API_KEY not found. Skipping AI processing.");
        await db.query("UPDATE learning_materials SET ai_status = 'failed' WHERE material_id = ?", [materialId]);
        return;
    }

    try {
        await db.query("UPDATE learning_materials SET ai_status = 'processing' WHERE material_id = ?", [materialId]);

        const ext = path.extname(filePath).toLowerCase();
        let contents = [];
        const basePrompt = `You are an expert AI tutor. I will provide you with a learning material.
Your task is to generate:
1. A concise summary of the material (2-3 paragraphs max).
2. A list of exactly 5 flashcards (Question and Answer format) to help the student test their knowledge on the core concepts.

Format your response EXACTLY as a JSON object with this schema:
{
  "summary": "The concise summary text...",
  "flashcards": [
    { "question": "Question 1?", "answer": "Answer 1" }
  ]
}

DO NOT output any markdown blocks like \`\`\`json. Output ONLY the raw JSON object.
`;

        if (ext === '.pdf') {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            if (!pdfData.text || pdfData.text.trim().length === 0) throw new Error("No readable text found in PDF");
            contents = [basePrompt + "\nText content:\n" + pdfData.text.substring(0, 30000)];
        } else if (ext === '.docx' || ext === '.pptx' || ext === '.doc' || ext === '.ppt') {
            const textContent = await officeParser.parseOfficeAsync(filePath);
            if (!textContent || textContent.trim().length === 0) throw new Error("No readable text found in document");
            contents = [basePrompt + "\nText content:\n" + textContent.substring(0, 30000)];
        } else if (['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext)) {
            const imageBuffer = fs.readFileSync(filePath);
            const base64Image = imageBuffer.toString("base64");
            contents = [
                basePrompt + "\nPlease analyze the attached image (it might contain diagrams, text, or lesson slides).",
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: getMimeType(ext)
                    }
                }
            ];
        } else {
            throw new Error(`Unsupported file type for AI Processing: ${ext}`);
        }

        // Call Gemini API with automated retry on temporary 503 / 429 demand spikes
        const response = await callGeminiWithRetry(contents, 4);

        let responseText = (response.text || '').trim();
        
        // Clean up markdown code blocks if the model returned them
        if (responseText.startsWith('```json')) {
            responseText = responseText.replace(/^```json/, '').replace(/```$/, '').trim();
        } else if (responseText.startsWith('```')) {
            responseText = responseText.replace(/^```/, '').replace(/```$/, '').trim();
        }

        // Robust JSON extraction
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Invalid AI response: No JSON object found in response");
        }

        const parsedResult = JSON.parse(jsonMatch[0]);
        const summary = parsedResult.summary || 'Summary unavailable.';
        const flashcards = JSON.stringify(parsedResult.flashcards || []);

        // Save to database
        await db.query(
            "UPDATE learning_materials SET ai_summary = ?, ai_flashcards = ?, ai_status = 'completed' WHERE material_id = ?",
            [summary, flashcards, materialId]
        );

        console.log(`✅ AI processing completed for material ${materialId} (Type: ${ext})`);

    } catch (err) {
        console.error(`❌ AI processing failed for material ${materialId}:`, err.message || err);
        await db.query("UPDATE learning_materials SET ai_status = 'failed' WHERE material_id = ?", [materialId]);
    }
}

module.exports = {
    processMaterialWithAI,
    callGeminiWithRetry
};

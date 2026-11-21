import { GoogleGenAI } from '@google/genai';

export function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return key;
}

export function createGeminiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getGeminiApiKey(),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function createBetaGeminiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: getGeminiApiKey(),
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function createDecisionsClient(): GoogleGenAI {
  return createBetaGeminiClient();
}

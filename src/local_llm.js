/**
 * Local LLM Client
 *
 * OpenAI-compatible Chat Completions API client for local LLM (LM Studio, etc.)
 * Used for OCR text refinement (typo correction, line break cleanup)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LLM_SYSTEM_PROMPT,
  LLM_USER_PROMPT_TEMPLATE,
  LLM_LINES_SYSTEM_PROMPT,
  LLM_LINES_USER_PROMPT_TEMPLATE,
  LLM_RENAME_EXTRACT_SYSTEM_PROMPT,
  LLM_RENAME_EXTRACT_USER_TEMPLATE,
  LLM_RENAME_VALIDATE_SYSTEM_PROMPT,
  LLM_RENAME_VALIDATE_USER_TEMPLATE,
  LLM_VISION_EXTRACT_SYSTEM_PROMPT,
  LLM_VISION_EXTRACT_USER_PROMPT
} from './llm_prompt.js';

// Default settings
const DEFAULT_API_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL = 'gemma3';
const DEFAULT_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Get LLM API URL from environment or default
 * @returns {string}
 */
export function getLlmApiUrl() {
  return process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL;
}

/**
 * Get LLM model name from environment or default
 * @returns {string}
 */
export function getLlmModel() {
  return process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL;
}

/**
 * Check if LLM is enabled
 * @returns {boolean}
 */
export function isLlmEnabled() {
  const enabled = process.env.LLM_ENABLED;
  // Disabled by default for safety (opt-in)
  if (enabled === undefined || enabled === '') {
    return false;
  }
  return enabled === 'true' || enabled === '1';
}

/**
 * Sanitize LLM output to remove unwanted artifacts
 *
 * @param {string} text - Raw LLM output
 * @param {string} originalText - Original input text for comparison
 * @returns {{text: string, valid: boolean, reason?: string}}
 */
export function sanitizeLlmOutput(text, originalText) {
  if (!text || typeof text !== 'string') {
    return { text: originalText, valid: false, reason: 'Empty or invalid output' };
  }

  let sanitized = text;

  // 1. Remove code fences (```...```)
  sanitized = sanitized.replace(/^```[\w]*\n?/gm, '');
  sanitized = sanitized.replace(/\n?```$/gm, '');

  // 2. Remove common LLM meta-commentary patterns
  const metaPatterns = [
    /^(整形後のテキスト|出力|結果|以下|修正後)[：:]\s*/gim,
    /^(Here is|The refined|I have|Below is).*[:：]\s*/gim,
    /^\s*---+\s*$/gm,
  ];
  for (const pattern of metaPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }

  // 3. Collapse excessive blank lines (max 2 consecutive)
  sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');

  // 4. Trim
  sanitized = sanitized.trim();

  // 5. Validate output length (fail-open if suspicious)
  const originalLen = originalText.length;
  const sanitizedLen = sanitized.length;

  // If output is more than 2x the input, something is wrong
  if (sanitizedLen > originalLen * 2) {
    return {
      text: originalText,
      valid: false,
      reason: `Output too long: ${sanitizedLen} chars vs input ${originalLen} chars`
    };
  }

  // If output is less than 20% of input (and input is substantial), likely truncated
  if (originalLen > 50 && sanitizedLen < originalLen * 0.2) {
    return {
      text: originalText,
      valid: false,
      reason: `Output too short: ${sanitizedLen} chars vs input ${originalLen} chars`
    };
  }

  // If output is empty after sanitization
  if (sanitizedLen === 0) {
    return {
      text: originalText,
      valid: false,
      reason: 'Output empty after sanitization'
    };
  }

  return { text: sanitized, valid: true };
}

/**
 * Check LLM API health
 * @param {string} apiUrl - API URL
 * @returns {Promise<boolean>} - True if healthy
 */
export async function checkLlmHealth(apiUrl = getLlmApiUrl()) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${apiUrl}/models`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Refine OCR text using local LLM
 *
 * @param {string} ocrText - Raw OCR text to refine
 * @param {Object} options - Options
 * @param {string} options.apiUrl - API URL (default: from env or http://localhost:1234/v1)
 * @param {string} options.model - Model name (default: from env or gemma3)
 * @param {number} options.timeout - Timeout in ms (default: 60000)
 * @returns {Promise<{text: string, success: boolean, error?: string}>}
 */
export async function refineOcrText(ocrText, options = {}) {
  const apiUrl = options.apiUrl || getLlmApiUrl();
  const model = options.model || getLlmModel();
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  // Build user prompt
  const userPrompt = LLM_USER_PROMPT_TEMPLATE.replace('{{OCR_TEXT}}', ocrText);

  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 4096,
    stream: false
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        text: ocrText,
        success: false,
        error: `LLM API error (${response.status}): ${errorText}`
      };
    }

    const result = await response.json();
    const rawOutput = result.choices?.[0]?.message?.content?.trim();

    if (!rawOutput) {
      return {
        text: ocrText,
        success: false,
        error: 'LLM returned empty response'
      };
    }

    // Sanitize output
    const sanitized = sanitizeLlmOutput(rawOutput, ocrText);
    if (!sanitized.valid) {
      return {
        text: ocrText,
        success: false,
        error: `Sanitization failed: ${sanitized.reason}`
      };
    }

    return {
      text: sanitized.text,
      success: true
    };

  } catch (error) {
    // Fail-open: return original text on any error
    return {
      text: ocrText,
      success: false,
      error: error.name === 'AbortError' ? 'LLM request timeout' : error.message
    };
  }
}

/**
 * Refine OCR text line by line (for bbox synchronization)
 *
 * This mode processes each line separately to maintain bbox alignment.
 * Use when searchable-pdf needs exact line count preservation.
 *
 * @param {string[]} lines - Array of OCR text lines
 * @param {Object} options - Same as refineOcrText
 * @returns {Promise<{lines: string[], success: boolean, error?: string}>}
 */
export async function refineOcrTextByLines(lines, options = {}) {
  const apiUrl = options.apiUrl || getLlmApiUrl();
  const model = options.model || getLlmModel();
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  // Build prompt for line-by-line mode using strict templates
  const userPrompt = LLM_LINES_USER_PROMPT_TEMPLATE
    .replace('{{LINE_COUNT}}', String(lines.length))
    .replaceAll('{{LINE_COUNT}}', String(lines.length))
    .replace('{{OCR_LINES}}', lines.join('\n'));

  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: LLM_LINES_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 4096,
    stream: false
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        lines: lines,
        success: false,
        error: `LLM API error (${response.status}): ${errorText}`
      };
    }

    const result = await response.json();
    const rawOutput = result.choices?.[0]?.message?.content?.trim();

    if (!rawOutput) {
      return {
        lines: lines,
        success: false,
        error: 'LLM returned empty response'
      };
    }

    // Sanitize: remove code fences
    let sanitized = rawOutput;
    sanitized = sanitized.replace(/^```[\w]*\n?/gm, '');
    sanitized = sanitized.replace(/\n?```$/gm, '');

    // Parse output lines
    let refinedLines = sanitized.split('\n').map(l => {
      let line = l.trim();
      // Remove numbered prefixes like "1. ", "2. " that LLM might add
      line = line.replace(/^\d+\.\s*/, '');
      return line;
    });

    // Filter out empty lines at start/end only
    while (refinedLines.length > 0 && refinedLines[0] === '') {
      refinedLines.shift();
    }
    while (refinedLines.length > 0 && refinedLines[refinedLines.length - 1] === '') {
      refinedLines.pop();
    }

    // Validate line count
    if (refinedLines.length !== lines.length) {
      return {
        lines: lines,
        success: false,
        error: `Line count mismatch: expected ${lines.length}, got ${refinedLines.length}`
      };
    }

    // Validate each line isn't drastically different in length
    for (let i = 0; i < lines.length; i++) {
      const origLen = lines[i].length;
      const newLen = refinedLines[i].length;
      // If a line grows more than 3x or shrinks to less than 10% (for non-tiny lines)
      if (origLen > 5 && (newLen > origLen * 3 || newLen < origLen * 0.1)) {
        return {
          lines: lines,
          success: false,
          error: `Line ${i + 1} length suspicious: ${origLen} -> ${newLen}`
        };
      }
    }

    return {
      lines: refinedLines,
      success: true
    };

  } catch (error) {
    return {
      lines: lines,
      success: false,
      error: error.name === 'AbortError' ? 'LLM request timeout' : error.message
    };
  }
}

// ========================================
// 2モデル推論: リネーム精度向上
// ========================================

/**
 * Parse JSON from LLM output (handles code fences and malformed JSON)
 * @param {string} text - Raw LLM output
 * @returns {Object|null} - Parsed JSON or null
 */
function parseJsonFromLlmOutput(text) {
  if (!text || typeof text !== 'string') return null;

  // Remove code fences
  let cleaned = text;
  cleaned = cleaned.replace(/^```(?:json)?\n?/gm, '');
  cleaned = cleaned.replace(/\n?```$/gm, '');
  cleaned = cleaned.trim();

  // Try to find JSON object in the output
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Model A (Gemma3): 構造化データ抽出
 *
 * @param {string} ocrText - OCRテキスト
 * @param {Object} options - オプション
 * @returns {Promise<{data: Object|null, success: boolean, error?: string}>}
 */
export async function extractStructuredData(ocrText, options = {}) {
  const apiUrl = options.apiUrl || getLlmApiUrl();
  const model = options.extractModel || 'gemma3';
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  const userPrompt = LLM_RENAME_EXTRACT_USER_TEMPLATE.replace('{{OCR_TEXT}}', ocrText);

  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: LLM_RENAME_EXTRACT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 1024,
    stream: false
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        data: null,
        success: false,
        error: `Extract API error (${response.status}): ${errorText}`
      };
    }

    const result = await response.json();
    const rawOutput = result.choices?.[0]?.message?.content?.trim();

    if (!rawOutput) {
      return { data: null, success: false, error: 'Extract returned empty response' };
    }

    const parsed = parseJsonFromLlmOutput(rawOutput);
    if (!parsed) {
      return { data: null, success: false, error: 'Failed to parse extraction JSON' };
    }

    return { data: parsed, success: true };

  } catch (error) {
    return {
      data: null,
      success: false,
      error: error.name === 'AbortError' ? 'Extract request timeout' : error.message
    };
  }
}

/**
 * Model B (Qwen3): 検証・補正
 *
 * @param {Object} extractedData - Model Aの抽出結果
 * @param {string} ocrText - 元のOCRテキスト
 * @param {Object} options - オプション
 * @returns {Promise<{data: Object|null, success: boolean, error?: string}>}
 */
export async function validateExtraction(extractedData, ocrText, options = {}) {
  const apiUrl = options.apiUrl || getLlmApiUrl();
  const model = options.validateModel || 'qwen3';
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  const userPrompt = LLM_RENAME_VALIDATE_USER_TEMPLATE
    .replace('{{EXTRACTED_DATA}}', JSON.stringify(extractedData, null, 2))
    .replace('{{OCR_TEXT}}', ocrText);

  const requestBody = {
    model: model,
    messages: [
      { role: 'system', content: LLM_RENAME_VALIDATE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 1024,
    stream: false
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        data: null,
        success: false,
        error: `Validate API error (${response.status}): ${errorText}`
      };
    }

    const result = await response.json();
    const rawOutput = result.choices?.[0]?.message?.content?.trim();

    if (!rawOutput) {
      return { data: null, success: false, error: 'Validate returned empty response' };
    }

    const parsed = parseJsonFromLlmOutput(rawOutput);
    if (!parsed) {
      return { data: null, success: false, error: 'Failed to parse validation JSON' };
    }

    return { data: parsed, success: true };

  } catch (error) {
    return {
      data: null,
      success: false,
      error: error.name === 'AbortError' ? 'Validate request timeout' : error.message
    };
  }
}

/**
 * 2モデル推論パイプライン
 *
 * PaddleOCR → Gemma3 (抽出) → Qwen3 (検証)
 *
 * @param {string} ocrText - OCRテキスト
 * @param {Object} options - オプション
 * @param {string} options.extractModel - 抽出モデル (default: gemma3)
 * @param {string} options.validateModel - 検証モデル (default: qwen3)
 * @returns {Promise<{data: Object, success: boolean, pipeline: string[], error?: string}>}
 */
export async function runTwoModelInference(ocrText, options = {}) {
  const pipeline = [];

  // Step 1: Gemma3 で抽出
  pipeline.push('extract:start');
  const extractResult = await extractStructuredData(ocrText, options);

  if (!extractResult.success || !extractResult.data) {
    pipeline.push(`extract:failed:${extractResult.error}`);
    return {
      data: { date: null, docType: null, company: null, material: null, confidence: 0 },
      success: false,
      pipeline,
      error: `Extraction failed: ${extractResult.error}`
    };
  }
  pipeline.push('extract:success');

  // Step 2: Qwen3 で検証
  pipeline.push('validate:start');
  const validateResult = await validateExtraction(extractResult.data, ocrText, options);

  if (!validateResult.success || !validateResult.data) {
    // 検証失敗時は抽出結果をそのまま使用
    pipeline.push(`validate:failed:${validateResult.error}`);
    return {
      data: extractResult.data,
      success: true, // 抽出は成功しているので
      pipeline,
      error: `Validation failed (using extraction result): ${validateResult.error}`
    };
  }
  pipeline.push('validate:success');

  return {
    data: validateResult.data,
    success: true,
    pipeline
  };
}

// ========================================
// Vision-Language モデル推論 (Qwen3-VL)
// ========================================

/**
 * Read image file and encode as base64 data URL
 * @param {string} imagePath - Path to image file
 * @returns {Promise<string>} - Base64 data URL
 */
async function imageToBase64DataUrl(imagePath) {
  const imageBuffer = await fs.readFile(imagePath);
  const ext = path.extname(imagePath).toLowerCase();

  let mimeType;
  switch (ext) {
    case '.png':
      mimeType = 'image/png';
      break;
    case '.jpg':
    case '.jpeg':
      mimeType = 'image/jpeg';
      break;
    case '.gif':
      mimeType = 'image/gif';
      break;
    case '.webp':
      mimeType = 'image/webp';
      break;
    default:
      mimeType = 'image/png';
  }

  const base64 = imageBuffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Vision Model (Qwen3-VL): 画像から直接情報を抽出
 *
 * @param {string} imagePath - 画像ファイルパス
 * @param {Object} options - オプション
 * @param {string} options.visionModel - Vision モデル名 (default: qwen3-vl)
 * @returns {Promise<{data: Object|null, success: boolean, error?: string}>}
 */
export async function extractFromImage(imagePath, options = {}) {
  const apiUrl = options.apiUrl || getLlmApiUrl();
  const model = options.visionModel || 'qwen3-vl';
  const timeout = options.timeout || 120000; // Vision is slower, 120s timeout

  try {
    // Read and encode image
    const imageDataUrl = await imageToBase64DataUrl(imagePath);

    const requestBody = {
      model: model,
      messages: [
        { role: 'system', content: LLM_VISION_EXTRACT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: imageDataUrl }
            },
            {
              type: 'text',
              text: LLM_VISION_EXTRACT_USER_PROMPT
            }
          ]
        }
      ],
      temperature: 0,
      max_tokens: 1024,
      stream: false
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        data: null,
        success: false,
        error: `Vision API error (${response.status}): ${errorText}`
      };
    }

    const result = await response.json();
    const rawOutput = result.choices?.[0]?.message?.content?.trim();

    if (!rawOutput) {
      return { data: null, success: false, error: 'Vision returned empty response' };
    }

    const parsed = parseJsonFromLlmOutput(rawOutput);
    if (!parsed) {
      return { data: null, success: false, error: `Failed to parse vision JSON: ${rawOutput.substring(0, 200)}` };
    }

    return { data: parsed, success: true };

  } catch (error) {
    return {
      data: null,
      success: false,
      error: error.name === 'AbortError' ? 'Vision request timeout' : error.message
    };
  }
}

/**
 * Vision + Text 2モデル推論パイプライン
 *
 * Qwen3-VL (画像から抽出) → Qwen3 (検証)
 *
 * @param {string} ocrText - OCRテキスト（検証用）
 * @param {string} imagePath - 画像ファイルパス
 * @param {Object} options - オプション
 * @returns {Promise<{data: Object, success: boolean, pipeline: string[], error?: string}>}
 */
export async function runVisionInference(ocrText, imagePath, options = {}) {
  const pipeline = [];

  // Step 1: Qwen3-VL で画像から直接抽出
  pipeline.push('vision:start');
  const visionResult = await extractFromImage(imagePath, options);

  if (!visionResult.success || !visionResult.data) {
    pipeline.push(`vision:failed:${visionResult.error}`);
    // Fallback to text-only inference
    pipeline.push('fallback:text-only');
    return runTwoModelInference(ocrText, options);
  }
  pipeline.push('vision:success');

  // Step 2: Qwen3 で検証（OCRテキストと照合）
  pipeline.push('validate:start');
  const validateResult = await validateExtraction(visionResult.data, ocrText, options);

  if (!validateResult.success || !validateResult.data) {
    // 検証失敗時はVision結果をそのまま使用
    pipeline.push(`validate:failed:${validateResult.error}`);
    return {
      data: visionResult.data,
      success: true,
      pipeline,
      error: `Validation failed (using vision result): ${validateResult.error}`
    };
  }
  pipeline.push('validate:success');

  return {
    data: validateResult.data,
    success: true,
    pipeline
  };
}

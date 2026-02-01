/**
 * Local LLM Client
 *
 * OpenAI-compatible Chat Completions API client for local LLM (LM Studio, etc.)
 * Used for OCR text refinement (typo correction, line break cleanup)
 */

import {
  LLM_SYSTEM_PROMPT,
  LLM_USER_PROMPT_TEMPLATE,
  LLM_LINES_SYSTEM_PROMPT,
  LLM_LINES_USER_PROMPT_TEMPLATE
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

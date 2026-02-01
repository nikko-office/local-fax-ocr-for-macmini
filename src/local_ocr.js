/**
 * Local OCR API Client
 *
 * Client for PaddleOCR API running in Docker
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// Default API endpoint
const DEFAULT_API_URL = 'http://localhost:8765';

/**
 * Perform OCR using Local OCR API
 * @param {string} imagePath - Image file path
 * @param {Object} options - Options
 * @param {string} options.apiUrl - API URL (default: http://localhost:8765)
 * @param {boolean} options.preprocess - Enable preprocessing (default: true)
 * @returns {Promise<Object>} - Google Vision API compatible response (fullTextAnnotation)
 */
export async function performLocalOcr(imagePath, options = {}) {
  const apiUrl = options.apiUrl || process.env.LOCAL_OCR_API_URL || DEFAULT_API_URL;
  const preprocess = options.preprocess !== false;

  // Read image file
  const imageBuffer = await fs.readFile(imagePath);
  const filename = path.basename(imagePath);

  // Create FormData
  const formData = new FormData();
  const blob = new Blob([imageBuffer]);
  formData.append('file', blob, filename);

  // Call API
  const url = `${apiUrl}/ocr?preprocess=${preprocess}`;

  const response = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Local OCR API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  // Return Google Vision API compatible format
  return {
    text: result.text || '',
    pages: result.pages || []
  };
}

/**
 * Check Local OCR API health
 * @param {string} apiUrl - API URL
 * @returns {Promise<boolean>} - True if healthy
 */
export async function checkLocalOcrHealth(apiUrl = DEFAULT_API_URL) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${apiUrl}/health`, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Get Local OCR API URL from environment or default
 * @returns {string}
 */
export function getLocalOcrApiUrl() {
  return process.env.LOCAL_OCR_API_URL || DEFAULT_API_URL;
}

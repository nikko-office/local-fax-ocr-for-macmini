/**
 * OCR Provider - Local OCR / Google Vision switching
 *
 * Switch via OCR_PROVIDER environment variable:
 * - "local" (default): Local PaddleOCR API（完全オフライン）
 * - "google": Google Vision API（外部API）
 * - "auto": Local preferred, fallback to Google
 */

import { performOcr as performGoogleOcr } from './vision_ocr.js';
import { performLocalOcr, checkLocalOcrHealth, getLocalOcrApiUrl } from './local_ocr.js';

/**
 * Get current OCR provider setting
 * @returns {string} - "local", "google", or "auto"
 */
export function getOcrProvider() {
  return process.env.OCR_PROVIDER || 'local';
}

/**
 * Perform OCR (auto-select provider)
 * @param {string} imagePath - Image file path
 * @param {string|Object} apiKeyOrOptions - API key (string) or options object
 * @returns {Promise<Object>} - fullTextAnnotation format
 */
export async function performOcr(imagePath, apiKeyOrOptions) {
  // Handle both old signature (imagePath, apiKey) and new signature (imagePath, options)
  let options = {};
  let apiKey = null;

  if (typeof apiKeyOrOptions === 'string') {
    apiKey = apiKeyOrOptions;
  } else if (apiKeyOrOptions && typeof apiKeyOrOptions === 'object') {
    options = apiKeyOrOptions;
    apiKey = options.apiKey;
  }

  const provider = options.provider || getOcrProvider();

  switch (provider) {
    case 'local':
      return performLocalOcr(imagePath, options);

    case 'auto': {
      // Local preferred, fallback to Google on failure
      const localApiUrl = getLocalOcrApiUrl();
      if (await checkLocalOcrHealth(localApiUrl)) {
        try {
          return await performLocalOcr(imagePath, options);
        } catch (error) {
          console.warn(`Local OCR failed, falling back to Google: ${error.message}`);
        }
      }
      // Fallback
      const fallbackApiKey = apiKey || process.env.GOOGLE_CLOUD_API_KEY;
      if (!fallbackApiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is required for fallback');
      }
      return performGoogleOcr(imagePath, fallbackApiKey);
    }

    case 'google':
    default: {
      const googleApiKey = apiKey || process.env.GOOGLE_CLOUD_API_KEY;
      if (!googleApiKey) {
        throw new Error('GOOGLE_CLOUD_API_KEY is required');
      }
      return performGoogleOcr(imagePath, googleApiKey);
    }
  }
}

/**
 * Get available OCR providers
 * @returns {Promise<string[]>}
 */
export async function getAvailableProviders() {
  const providers = [];

  // Google Vision
  if (process.env.GOOGLE_CLOUD_API_KEY) {
    providers.push('google');
  }

  // Local OCR
  if (await checkLocalOcrHealth()) {
    providers.push('local');
  }

  return providers;
}

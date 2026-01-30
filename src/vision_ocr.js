/**
 * Vision OCR - Google Cloud Vision API integration
 */

import fs from 'node:fs/promises';
import crypto from 'node:crypto';

/**
 * Compute SHA256 hash of file
 * @param {string} filePath
 * @returns {Promise<string>} - Hex-encoded SHA256
 */
export async function computeFileHash(filePath) {
  const content = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}

/**
 * Perform OCR on an image file using Google Cloud Vision API
 * @param {string} imagePath - Path to PNG/JPG file
 * @param {string} apiKey - Google Cloud API key
 * @returns {Promise<Object>} - Vision API fullTextAnnotation response
 */
export async function performOcr(imagePath, apiKey) {
  // Read image and encode as base64
  const imageBuffer = await fs.readFile(imagePath);
  const base64Image = imageBuffer.toString('base64');

  // Prepare request body
  const requestBody = {
    requests: [
      {
        image: {
          content: base64Image
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION'
          }
        ],
        imageContext: {
          languageHints: ['ja', 'en']
        }
      }
    ]
  };

  // Call Vision API
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  // Check for API-level errors
  if (result.responses?.[0]?.error) {
    const error = result.responses[0].error;
    throw new Error(`Vision API error: ${error.message} (code: ${error.code})`);
  }

  // Return fullTextAnnotation (may be undefined if no text found)
  const fullTextAnnotation = result.responses?.[0]?.fullTextAnnotation;

  if (!fullTextAnnotation) {
    // No text detected - return empty structure
    return {
      text: '',
      pages: []
    };
  }

  return fullTextAnnotation;
}

/**
 * Perform OCR using service account credentials (alternative to API key)
 * @param {string} imagePath - Path to PNG/JPG file
 * @param {string} credentialsPath - Path to service account JSON
 * @returns {Promise<Object>} - Vision API fullTextAnnotation response
 */
export async function performOcrWithCredentials(imagePath, credentialsPath) {
  // Read credentials
  const credentialsContent = await fs.readFile(credentialsPath, 'utf-8');
  const credentials = JSON.parse(credentialsContent);

  // Get access token using service account
  const accessToken = await getAccessToken(credentials);

  // Read image and encode as base64
  const imageBuffer = await fs.readFile(imagePath);
  const base64Image = imageBuffer.toString('base64');

  // Prepare request body
  const requestBody = {
    requests: [
      {
        image: {
          content: base64Image
        },
        features: [
          {
            type: 'DOCUMENT_TEXT_DETECTION'
          }
        ],
        imageContext: {
          languageHints: ['ja', 'en']
        }
      }
    ]
  };

  // Call Vision API with Bearer token
  const url = 'https://vision.googleapis.com/v1/images:annotate';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();

  if (result.responses?.[0]?.error) {
    const error = result.responses[0].error;
    throw new Error(`Vision API error: ${error.message} (code: ${error.code})`);
  }

  const fullTextAnnotation = result.responses?.[0]?.fullTextAnnotation;

  if (!fullTextAnnotation) {
    return {
      text: '',
      pages: []
    };
  }

  return fullTextAnnotation;
}

/**
 * Get access token from service account credentials
 * @param {Object} credentials - Service account credentials
 * @returns {Promise<string>} - Access token
 */
async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600; // 1 hour

  // Create JWT header and claim
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const claim = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: expiry
  };

  // Encode header and claim
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaim = base64UrlEncode(JSON.stringify(claim));

  // Create signature
  const signatureInput = `${encodedHeader}.${encodedClaim}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signatureInput);
  const signature = sign.sign(credentials.private_key, 'base64url');

  // Create JWT
  const jwt = `${signatureInput}.${signature}`;

  // Exchange JWT for access token
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const tokenData = await tokenResponse.json();
  return tokenData.access_token;
}

/**
 * Base64 URL encode
 * @param {string} str
 * @returns {string}
 */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

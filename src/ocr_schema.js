/**
 * OCR Schema - OcrDocument の定義と生成
 * Rust版 faxocr の設計を継承
 *
 * 座標系: 左上原点, Y軸下向き正, 単位はピクセル
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * @typedef {Object} BBox
 * @property {number} x0 - Left edge (pixels)
 * @property {number} y0 - Top edge (pixels)
 * @property {number} x1 - Right edge (pixels)
 * @property {number} y1 - Bottom edge (pixels)
 */

/**
 * @typedef {Object} OcrToken
 * @property {string} id - UUID v4 with "tok_" prefix
 * @property {string} text - Token text
 * @property {BBox|null} bbox - Bounding box (null if unavailable)
 * @property {number} confidence - Confidence score (0.0-1.0)
 */

/**
 * @typedef {Object} OcrLine
 * @property {string} id - UUID v4 with "ln_" prefix
 * @property {string} text - Concatenated token text
 * @property {BBox|null} bbox - Union of token bboxes
 * @property {OcrToken[]} tokens - Tokens in reading order (left to right)
 */

/**
 * @typedef {Object} OcrBlock
 * @property {string} id - UUID v4 with "blk_" prefix
 * @property {BBox|null} bbox - Union of line bboxes
 * @property {OcrLine[]} lines - Lines in reading order (top to bottom)
 */

/**
 * @typedef {Object} OcrPage
 * @property {number} page_index - 0-based page index
 * @property {number} width - Page width in pixels
 * @property {number} height - Page height in pixels
 * @property {OcrBlock[]} blocks - Blocks in reading order
 */

/**
 * @typedef {Object} OcrDocument
 * @property {string} schema_version - Schema version "1.0.0"
 * @property {string} source_file - Original filename
 * @property {string} source_sha256 - SHA256 hash of input file
 * @property {string} ocr_engine - "google_vision"
 * @property {string} created_at - ISO 8601 timestamp
 * @property {string} raw_text - Full extracted text
 * @property {OcrPage[]} pages - Array of pages
 */

/**
 * Generate prefixed UUID
 * @param {string} prefix - "blk_", "ln_", or "tok_"
 * @returns {string}
 */
export function generateId(prefix) {
  return `${prefix}${uuidv4()}`;
}

/**
 * Convert Google Vision vertices to BBox
 * @param {Array<{x?: number, y?: number}>} vertices - 4 corner vertices
 * @returns {BBox|null}
 */
export function bboxFromVertices(vertices) {
  if (!vertices || vertices.length < 4) {
    return null;
  }

  // Extract x and y values, defaulting to 0 if undefined
  const xs = vertices.map(v => v.x ?? 0);
  const ys = vertices.map(v => v.y ?? 0);

  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys)
  };
}

/**
 * Merge multiple bboxes into union
 * @param {BBox[]} bboxes - Array of bboxes
 * @returns {BBox|null}
 */
export function mergeBboxes(bboxes) {
  const validBboxes = bboxes.filter(b => b !== null);
  if (validBboxes.length === 0) {
    return null;
  }

  return {
    x0: Math.min(...validBboxes.map(b => b.x0)),
    y0: Math.min(...validBboxes.map(b => b.y0)),
    x1: Math.max(...validBboxes.map(b => b.x1)),
    y1: Math.max(...validBboxes.map(b => b.y1))
  };
}

/**
 * Create OcrDocument from Google Vision API response
 * @param {Object} visionResponse - fullTextAnnotation from Vision API
 * @param {string} sourceFile - Original filename
 * @param {string} sourceSha256 - SHA256 hash
 * @param {number} imageWidth - Image width in pixels
 * @param {number} imageHeight - Image height in pixels
 * @returns {OcrDocument}
 */
export function createOcrDocument(visionResponse, sourceFile, sourceSha256, imageWidth, imageHeight) {
  const pages = [];

  // Extract raw text
  const rawText = visionResponse?.text || '';

  // Process pages from fullTextAnnotation
  const visionPages = visionResponse?.pages || [];

  if (visionPages.length === 0) {
    // Fallback: create single page with no blocks if no structured data
    pages.push({
      page_index: 0,
      width: imageWidth,
      height: imageHeight,
      blocks: []
    });
  } else {
    for (let pageIdx = 0; pageIdx < visionPages.length; pageIdx++) {
      const visionPage = visionPages[pageIdx];
      const pageWidth = visionPage.width || imageWidth;
      const pageHeight = visionPage.height || imageHeight;

      const blocks = [];
      const visionBlocks = visionPage.blocks || [];

      for (const visionBlock of visionBlocks) {
        const lines = [];
        const visionParagraphs = visionBlock.paragraphs || [];

        for (const paragraph of visionParagraphs) {
          // Build lines from words
          const lineTokens = [];
          const visionWords = paragraph.words || [];

          for (const word of visionWords) {
            // Concatenate symbols to form word text
            const symbols = word.symbols || [];
            let wordText = '';
            let wordConfidence = 0;

            for (const symbol of symbols) {
              wordText += symbol.text || '';
              wordConfidence += symbol.confidence || 0;
            }

            if (symbols.length > 0) {
              wordConfidence /= symbols.length;
            }

            const wordBbox = bboxFromVertices(word.boundingBox?.vertices);

            lineTokens.push({
              id: generateId('tok_'),
              text: wordText,
              bbox: wordBbox,
              confidence: wordConfidence
            });
          }

          // Create line from tokens
          if (lineTokens.length > 0) {
            const lineText = lineTokens.map(t => t.text).join('');
            const lineBbox = mergeBboxes(lineTokens.map(t => t.bbox));

            lines.push({
              id: generateId('ln_'),
              text: lineText,
              bbox: lineBbox,
              tokens: lineTokens
            });
          }
        }

        // Create block from lines
        if (lines.length > 0) {
          const blockBbox = bboxFromVertices(visionBlock.boundingBox?.vertices);

          blocks.push({
            id: generateId('blk_'),
            bbox: blockBbox,
            lines: lines
          });
        }
      }

      pages.push({
        page_index: pageIdx,
        width: pageWidth,
        height: pageHeight,
        blocks: blocks
      });
    }
  }

  return {
    schema_version: '1.0.0',
    source_file: sourceFile,
    source_sha256: sourceSha256,
    ocr_engine: 'google_vision',
    created_at: new Date().toISOString(),
    raw_text: rawText,
    pages: pages
  };
}

/**
 * Extract full text from OcrDocument
 * @param {OcrDocument} doc
 * @returns {string}
 */
export function extractFullText(doc) {
  // Prefer raw_text if available
  if (doc.raw_text) {
    return doc.raw_text;
  }

  // Otherwise concatenate from structure
  const texts = [];
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        texts.push(line.text);
      }
    }
  }
  return texts.join('\n');
}

/**
 * Get lines from top portion of first page (for header extraction)
 * @param {OcrDocument} doc
 * @param {number} topRatio - Ratio of page height to consider as "top" (default 0.3)
 * @returns {OcrLine[]}
 */
export function getTopLines(doc, topRatio = 0.3) {
  if (doc.pages.length === 0) {
    return [];
  }

  const firstPage = doc.pages[0];
  const cutoffY = firstPage.height * topRatio;
  const topLines = [];

  for (const block of firstPage.blocks) {
    for (const line of block.lines) {
      // Include line if its top edge is within the top portion
      if (line.bbox && line.bbox.y0 <= cutoffY) {
        topLines.push(line);
      } else if (!line.bbox) {
        // If no bbox, include first few lines as fallback
        if (topLines.length < 10) {
          topLines.push(line);
        }
      }
    }
  }

  return topLines;
}

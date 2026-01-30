/**
 * Rename Suggest - リネーム提案ロジック
 *
 * 抽出対象:
 * - 日付: 令和X年Y月Z日, YYYY/MM/DD, YYYY-MM-DD
 * - 書類種別: 請求書, 見積書, 注文書, 納品書 等
 * - 宛先: 〇〇御中, 〇〇様（日興金属は自社なので除外）
 * - 材質: SS400, SM400A/B/C, SUS304 等
 * - 点数/図面番号
 *
 * Confidence:
 * - 4項目以上 → 0.95
 * - 3項目 → 0.9
 * - 2項目 → 0.7
 * - 1項目 → 0.4
 * - 0項目 → 0.1
 */

/**
 * @typedef {Object} ExtractionResult
 * @property {string|null} value - Normalized value
 * @property {string|null} raw - Raw matched text
 */

/**
 * @typedef {Object} RenameSuggestion
 * @property {string} stem - Proposed filename without extension
 * @property {number} confidence - 0.0-1.0
 * @property {string[]} reasons - Array of extraction details
 */

// 令和年号の開始年（2019年）
const REIWA_START_YEAR = 2019;

// 自社名リスト（ファイル名から除外）
const SELF_COMPANY_NAMES = [
  '日興金属',
  '日興金属株式会社',
  '株式会社日興金属'
];

// 書類種別パターン（優先順）
const DOC_TYPES = [
  { pattern: /御?見積書/u, normalized: '見積書' },
  { pattern: /見積依頼/u, normalized: '見積依頼' },
  { pattern: /請求書/u, normalized: '請求書' },
  { pattern: /注文書/u, normalized: '注文書' },
  { pattern: /発注書/u, normalized: '発注書' },
  { pattern: /納品書/u, normalized: '納品書' },
  { pattern: /領収書/u, normalized: '領収書' },
  { pattern: /契約書/u, normalized: '契約書' },
  { pattern: /報告書/u, normalized: '報告書' },
  { pattern: /仕様書/u, normalized: '仕様書' },
  { pattern: /図面/u, normalized: '図面' }
];

// 材質パターン
const MATERIAL_PATTERNS = [
  /\b(SS400)\b/gi,
  /\b(SM400[ABC]?)\b/gi,
  /\b(SM490[ABC]?)\b/gi,
  /\b(SUS304)\b/gi,
  /\b(SUS430)\b/gi,
  /\b(SUS316[L]?)\b/gi,
  /\b(SPHC)\b/gi,
  /\b(SPCC)\b/gi,
  /\b(SECC)\b/gi,
  /\b(SGCC)\b/gi,
  /\b(A5052)\b/gi,
  /\b(A5083)\b/gi,
  /\b(A6061)\b/gi,
  /\b(C1100)\b/gi,
  /\b(C2801)\b/gi,
  /\b(SKD11)\b/gi,
  /\b(S45C)\b/gi,
  /\b(S50C)\b/gi,
  /\b(SCM435)\b/gi
];

/**
 * Check if a company name is self company (should be excluded)
 * @param {string} name
 * @returns {boolean}
 */
export function isSelfCompany(name) {
  if (!name) return false;
  const normalized = name.replace(/\s+/g, '');
  return SELF_COMPANY_NAMES.some(self => normalized.includes(self.replace(/\s+/g, '')));
}

/**
 * Extract date from text
 * Patterns: 令和X年Y月Z日, YYYY/MM/DD, YYYY-MM-DD, YYYYMMDD
 * @param {string} text - Full OCR text
 * @returns {ExtractionResult}
 */
export function extractDate(text) {
  // Pattern 1: 令和X年Y月Z日
  const reiwaMatch = text.match(/令和\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u);
  if (reiwaMatch) {
    const reiwaYear = parseInt(reiwaMatch[1], 10);
    const month = parseInt(reiwaMatch[2], 10);
    const day = parseInt(reiwaMatch[3], 10);
    const year = REIWA_START_YEAR + reiwaYear - 1;
    const value = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    return { value, raw: reiwaMatch[0] };
  }

  // Pattern 2: 平成X年Y月Z日
  const heiseiMatch = text.match(/平成\s*(\d{1,2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u);
  if (heiseiMatch) {
    const heiseiYear = parseInt(heiseiMatch[1], 10);
    const month = parseInt(heiseiMatch[2], 10);
    const day = parseInt(heiseiMatch[3], 10);
    const year = 1988 + heiseiYear; // 平成元年 = 1989
    const value = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    return { value, raw: heiseiMatch[0] };
  }

  // Pattern 3: YYYY年MM月DD日
  const jpDateMatch = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u);
  if (jpDateMatch) {
    const year = jpDateMatch[1];
    const month = String(parseInt(jpDateMatch[2], 10)).padStart(2, '0');
    const day = String(parseInt(jpDateMatch[3], 10)).padStart(2, '0');
    return { value: `${year}${month}${day}`, raw: jpDateMatch[0] };
  }

  // Pattern 4: YYYY/MM/DD or YYYY/M/D
  const slashMatch = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    const year = slashMatch[1];
    const month = String(parseInt(slashMatch[2], 10)).padStart(2, '0');
    const day = String(parseInt(slashMatch[3], 10)).padStart(2, '0');
    return { value: `${year}${month}${day}`, raw: slashMatch[0] };
  }

  // Pattern 5: YYYY-MM-DD
  const dashMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (dashMatch) {
    const year = dashMatch[1];
    const month = String(parseInt(dashMatch[2], 10)).padStart(2, '0');
    const day = String(parseInt(dashMatch[3], 10)).padStart(2, '0');
    return { value: `${year}${month}${day}`, raw: dashMatch[0] };
  }

  // Pattern 6: R6.1.30 形式 (令和略式)
  const reiwaShortMatch = text.match(/R\s*(\d{1,2})[.\s](\d{1,2})[.\s](\d{1,2})/i);
  if (reiwaShortMatch) {
    const reiwaYear = parseInt(reiwaShortMatch[1], 10);
    const month = parseInt(reiwaShortMatch[2], 10);
    const day = parseInt(reiwaShortMatch[3], 10);
    const year = REIWA_START_YEAR + reiwaYear - 1;
    const value = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    return { value, raw: reiwaShortMatch[0] };
  }

  return { value: null, raw: null };
}

/**
 * Extract document type from text
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractDocType(text) {
  for (const docType of DOC_TYPES) {
    const match = text.match(docType.pattern);
    if (match) {
      return { value: docType.normalized, raw: match[0] };
    }
  }
  return { value: null, raw: null };
}

/**
 * Extract counterpart (company/person name) from text
 * Excludes self company names (日興金属)
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractCounterpart(text) {
  // Pattern 1: 会社名 御中
  const gochuMatch = text.match(/([^\s\n]{2,20}?(?:株式会社|有限会社|合同会社)?[^\s\n]*?)\s*御中/u);
  if (gochuMatch) {
    let name = gochuMatch[1].trim();
    name = name.replace(/^[御お]/, '');
    // 自社名チェック
    if (name.length >= 2 && !isSelfCompany(name)) {
      return { value: name, raw: gochuMatch[0] };
    }
  }

  // Pattern 2: 会社名 様
  const samaMatch = text.match(/([^\s\n]{2,20}?(?:株式会社|有限会社|合同会社)?[^\s\n]*?)\s*様/u);
  if (samaMatch) {
    let name = samaMatch[1].trim();
    name = name.replace(/^[御お]/, '');
    if (name.length >= 2 && !isSelfCompany(name)) {
      return { value: name, raw: samaMatch[0] };
    }
  }

  // Pattern 3: 株式会社〇〇 or 〇〇株式会社 (without 御中/様)
  const companyMatch = text.match(/(株式会社[^\s\n]{2,15}|[^\s\n]{2,15}株式会社)/u);
  if (companyMatch && !isSelfCompany(companyMatch[1])) {
    return { value: companyMatch[1], raw: companyMatch[0] };
  }

  // Pattern 4: 有限会社〇〇 or 〇〇有限会社
  const yugenMatch = text.match(/(有限会社[^\s\n]{2,15}|[^\s\n]{2,15}有限会社)/u);
  if (yugenMatch && !isSelfCompany(yugenMatch[1])) {
    return { value: yugenMatch[1], raw: yugenMatch[0] };
  }

  return { value: null, raw: null };
}

/**
 * Extract materials from text
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractMaterials(text) {
  const found = new Set();
  const raws = [];

  for (const pattern of MATERIAL_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const material = match[1].toUpperCase();
      if (!found.has(material)) {
        found.add(material);
        raws.push(match[0]);
      }
    }
  }

  if (found.size > 0) {
    const materials = Array.from(found);
    return {
      value: materials.join('_'),
      raw: raws.join(', ')
    };
  }

  return { value: null, raw: null };
}

/**
 * Extract item count from text
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractItemCount(text) {
  // Pattern: 数字 + 単位（点、品目、枚、本、個、件）
  const countMatches = [...text.matchAll(/(\d+)\s*(点|品目|枚|本|個|件)/gu)];

  if (countMatches.length > 0) {
    // 合計を計算
    let total = 0;
    const units = new Set();

    for (const match of countMatches) {
      total += parseInt(match[1], 10);
      units.add(match[2]);
    }

    // 最も一般的な単位を使用
    const unit = units.has('品目') ? '品目' : units.has('点') ? '点' : Array.from(units)[0];
    return {
      value: `${total}${unit}`,
      raw: countMatches.map(m => m[0]).join(', ')
    };
  }

  return { value: null, raw: null };
}

/**
 * Extract drawing numbers from text
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractDrawingNumbers(text) {
  // Pattern: 数字-数字 形式（図面番号）
  const drawingMatches = [...text.matchAll(/\b(\d{2,4}[-−]\d{4,6})\b/g)];

  if (drawingMatches.length > 0) {
    const numbers = [...new Set(drawingMatches.map(m => m[1]))];

    if (numbers.length <= 2) {
      return {
        value: numbers.join('_'),
        raw: numbers.join(', ')
      };
    } else {
      return {
        value: `${numbers.length}図面`,
        raw: `${numbers.length}件の図面番号`
      };
    }
  }

  return { value: null, raw: null };
}

/**
 * Sanitize filename for Windows/macOS safety
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') {
    return 'untitled';
  }

  let sanitized = name;

  // Replace forbidden characters: / \ : * ? " < > |
  sanitized = sanitized.replace(/[/\\:*?"<>|]/g, '_');

  // Replace whitespace with underscore
  sanitized = sanitized.replace(/\s+/g, '_');

  // Remove leading/trailing dots and spaces
  sanitized = sanitized.replace(/^[.\s]+|[.\s]+$/g, '');

  // Collapse consecutive underscores
  sanitized = sanitized.replace(/_+/g, '_');

  // Remove leading/trailing underscores
  sanitized = sanitized.replace(/^_+|_+$/g, '');

  // Handle Windows reserved names
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  // Truncate to max length (200 chars to be safe)
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  // Fallback if empty
  if (!sanitized) {
    return 'untitled';
  }

  return sanitized;
}

/**
 * Generate rename suggestion from OCR text
 * @param {string} fullText - Full OCR text
 * @param {string} originalFilename - Original filename (for fallback)
 * @returns {RenameSuggestion}
 */
export function suggestRename(fullText, originalFilename) {
  const reasons = [];
  let signalCount = 0;

  // Extract date
  const dateResult = extractDate(fullText);
  let datePart = null;
  if (dateResult.value) {
    datePart = dateResult.value;
    reasons.push(`date: ${dateResult.raw} -> ${dateResult.value}`);
    signalCount++;
  }

  // Extract document type
  const docTypeResult = extractDocType(fullText);
  let docTypePart = null;
  if (docTypeResult.value) {
    docTypePart = docTypeResult.value;
    reasons.push(`doc_type: ${docTypeResult.raw} -> ${docTypeResult.value}`);
    signalCount++;
  }

  // Extract counterpart (excluding self company)
  const counterpartResult = extractCounterpart(fullText);
  let counterpartPart = null;
  if (counterpartResult.value) {
    counterpartPart = counterpartResult.value;
    reasons.push(`counterpart: ${counterpartResult.raw} -> ${counterpartResult.value}`);
    signalCount++;
  }

  // Extract materials
  const materialsResult = extractMaterials(fullText);
  let materialsPart = null;
  if (materialsResult.value) {
    materialsPart = materialsResult.value;
    reasons.push(`materials: ${materialsResult.raw}`);
    signalCount++;
  }

  // Extract item count or drawing numbers
  const itemCountResult = extractItemCount(fullText);
  const drawingResult = extractDrawingNumbers(fullText);

  let contentPart = null;
  if (itemCountResult.value) {
    contentPart = itemCountResult.value;
    reasons.push(`item_count: ${itemCountResult.raw}`);
    signalCount++;
  } else if (drawingResult.value) {
    contentPart = drawingResult.value;
    reasons.push(`drawing: ${drawingResult.raw}`);
    signalCount++;
  }

  // Calculate confidence
  let confidence;
  if (signalCount >= 4) {
    confidence = 0.95;
  } else if (signalCount === 3) {
    confidence = 0.9;
  } else if (signalCount === 2) {
    confidence = 0.7;
  } else if (signalCount === 1) {
    confidence = 0.4;
  } else {
    confidence = 0.1;
  }

  // Build filename stem
  let stem;
  if (signalCount === 0) {
    // Fallback to original filename (without extension)
    stem = originalFilename.replace(/\.[^.]+$/, '');
    reasons.push(`fallback: using original filename`);
  } else {
    // Build parts in order: date, docType, counterpart, materials, content
    const parts = [];
    if (datePart) parts.push(datePart);
    if (docTypePart) parts.push(docTypePart);
    if (counterpartPart) parts.push(counterpartPart);
    if (materialsPart) parts.push(materialsPart);
    if (contentPart) parts.push(contentPart);

    stem = parts.join('_');
  }

  // Sanitize the stem
  stem = sanitizeFilename(stem);

  return {
    stem,
    confidence,
    reasons
  };
}

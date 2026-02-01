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

// 社員名リスト（ファイル名から除外）
// これらは宛先や差出人として抽出されても、ファイル名には採用しない
const EMPLOYEE_NAMES = [
  '荻田',
  '酒井',
  '真鍋',
  '中西',
  '社長',
  '専務',
  '部長',
  '課長',
  '係長'
];

// 自社電話/FAX番号リスト（伝票番号として採用しない）
const SELF_PHONE_NUMBERS = [
  '06-6482-3054',  // 日興金属FAX
  '0664823054',
  '06-6482-',      // 部分マッチ用
  '6482-3054'
];

// ミルシート製造元リスト（採用する）
const MILLSHEET_MANUFACTURERS = [
  '東京製鉄',
  '中山製鋼所',
  'JFEスチール',
  'JFE',
  '神戸製鋼所',
  '神戸製鋼',
  '日本製鉄',
  '住友金属',
  '新日鐵住金',
  '新日本製鐵',
  'POSCO',
  '阪神メタリックス'
];

// ミルシート商社リスト（採用しない）
const MILLSHEET_TRADING_COMPANIES = [
  '小野建',
  '中山通商',
  '岡本鋼材',
  '阪和興業',
  '日興金属',
  'メタルワン',
  'JFE商事',
  '伊藤忠丸紅鉄鋼'
];

// チャージ番号パターン（メーカー別）
// 注意: gフラグは使用しない（match()でキャプチャグループを取得するため）
const CHARGE_NUMBER_PATTERNS = [
  // 中山製鋼所: 数字2桁+英字+数字4桁 (例: 48D7503, 38D4748)
  { pattern: /\b(\d{2}[A-Z]\d{4,5})\b/i, manufacturer: '中山製鋼所' },
  // 東京製鉄: 英字2文字+数字4-5桁 (例: AD3898, AE1276)
  { pattern: /\b([A-Z]{2}\d{4,5})\b/, manufacturer: '東京製鉄' },
  // JFEスチール: 英数字混合 (例: JL7JU6Y73)
  { pattern: /\b([A-Z]{2}\d[A-Z0-9]{5,7})\b/, manufacturer: 'JFEスチール' },
  // 汎用: 6-10文字の英数字混合（最後の手段）
  { pattern: /\b([A-Z0-9]{6,10})\b/, manufacturer: null }
];

// 書類種別パターン（優先順）
// 揺らぎ対応: 口語的な表現も正式な書類名に正規化
// 部分マッチ対応: OCRで文字が途切れる場合も考慮
const DOC_TYPES = [
  // 正式名称
  { pattern: /御?見積書/u, normalized: '見積書' },
  { pattern: /見積依頼/u, normalized: '見積依頼' },
  { pattern: /見積依/u, normalized: '見積依頼' },  // 部分マッチ（OCR途切れ対応）
  { pattern: /請求書/u, normalized: '請求書' },
  { pattern: /注文書/u, normalized: '注文書' },
  { pattern: /発注書/u, normalized: '発注書' },
  { pattern: /納品書/u, normalized: '納品書' },
  { pattern: /領収書/u, normalized: '領収書' },
  { pattern: /契約書/u, normalized: '契約書' },
  { pattern: /報告書/u, normalized: '報告書' },
  { pattern: /仕様書/u, normalized: '仕様書' },
  { pattern: /図面/u, normalized: '図面' },
  // 揺らぎ対応（口語的な表現）
  { pattern: /見積[もり]?お願い/u, normalized: '見積依頼' },
  { pattern: /価格ください/u, normalized: '見積依頼' },
  { pattern: /価格お願い/u, normalized: '見積依頼' },
  { pattern: /お見積り?お願い/u, normalized: '見積依頼' },
  { pattern: /ミルシートください/u, normalized: 'ミルシート依頼' },
  { pattern: /ミルシートお願い/u, normalized: 'ミルシート依頼' },
  { pattern: /手配お願い/u, normalized: '発注依頼' },
  { pattern: /手配ください/u, normalized: '発注依頼' },
  { pattern: /注文します/u, normalized: '注文' },
  { pattern: /注文お願い/u, normalized: '注文' },
  { pattern: /発注お願い/u, normalized: '発注依頼' }
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
 * Check if a name is an employee name (should be excluded from filename)
 * @param {string} name
 * @returns {boolean}
 */
export function isEmployeeName(name) {
  if (!name) return false;
  return EMPLOYEE_NAMES.some(emp => name.includes(emp));
}

/**
 * Check if a string looks like a phone/FAX number (should not be used as slip number)
 * @param {string} str
 * @returns {boolean}
 */
export function isPhoneNumber(str) {
  if (!str) return false;
  // 自社電話番号チェック
  const normalizedStr = str.replace(/[-\s]/g, '');
  for (const phone of SELF_PHONE_NUMBERS) {
    const normalizedPhone = phone.replace(/[-\s]/g, '');
    if (normalizedStr.includes(normalizedPhone) || normalizedPhone.includes(normalizedStr)) {
      return true;
    }
  }
  // 一般的な電話番号パターン（00-0000-0000 形式）
  if (/^\d{2,4}[-\s]?\d{2,4}[-\s]?\d{3,4}$/.test(str)) {
    return true;
  }
  return false;
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

  // Pattern 7: FAXヘッダー形式 (YYYY/MM/DD HH:MM or YYYY-MM-DD HH:MM)
  // FAXヘッダーは文書の最上部に含まれることが多い
  const faxHeaderMatch = text.match(/(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})\s+\d{1,2}:\d{2}/);
  if (faxHeaderMatch) {
    const year = faxHeaderMatch[1];
    const month = String(parseInt(faxHeaderMatch[2], 10)).padStart(2, '0');
    const day = String(parseInt(faxHeaderMatch[3], 10)).padStart(2, '0');
    return { value: `${year}${month}${day}`, raw: faxHeaderMatch[0] };
  }

  // Pattern 8: 短縮年形式 MM/DD/YY (アメリカ式FAX)
  const shortYearMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})\s/);
  if (shortYearMatch) {
    const month = parseInt(shortYearMatch[1], 10);
    const day = parseInt(shortYearMatch[2], 10);
    let year = parseInt(shortYearMatch[3], 10);
    // 20xx年として解釈（00-99 -> 2000-2099）
    year = year + 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const value = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
      return { value, raw: shortYearMatch[0] };
    }
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
 * Excludes self company names (日興金属) and employee names
 * @param {string} text
 * @returns {ExtractionResult}
 */
export function extractCounterpart(text) {
  // Pattern 1: 会社名 御中
  const gochuMatch = text.match(/([^\s\n]{2,20}?(?:株式会社|有限会社|合同会社)?[^\s\n]*?)\s*御中/u);
  if (gochuMatch) {
    let name = gochuMatch[1].trim();
    name = name.replace(/^[御お]/, '');
    // 自社名・社員名チェック
    if (name.length >= 2 && !isSelfCompany(name) && !isEmployeeName(name)) {
      return { value: name, raw: gochuMatch[0] };
    }
  }

  // Pattern 2: 会社名 様
  const samaMatch = text.match(/([^\s\n]{2,20}?(?:株式会社|有限会社|合同会社)?[^\s\n]*?)\s*様/u);
  if (samaMatch) {
    let name = samaMatch[1].trim();
    name = name.replace(/^[御お]/, '');
    // 自社名・社員名チェック
    if (name.length >= 2 && !isSelfCompany(name) && !isEmployeeName(name)) {
      return { value: name, raw: samaMatch[0] };
    }
  }

  // Pattern 3: 株式会社〇〇 or 〇〇株式会社 (without 御中/様)
  const companyMatch = text.match(/(株式会社[^\s\n]{2,15}|[^\s\n]{2,15}株式会社)/u);
  if (companyMatch && !isSelfCompany(companyMatch[1]) && !isEmployeeName(companyMatch[1])) {
    return { value: companyMatch[1], raw: companyMatch[0] };
  }

  // Pattern 4: 有限会社〇〇 or 〇〇有限会社
  const yugenMatch = text.match(/(有限会社[^\s\n]{2,15}|[^\s\n]{2,15}有限会社)/u);
  if (yugenMatch && !isSelfCompany(yugenMatch[1]) && !isEmployeeName(yugenMatch[1])) {
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

// ========================================
// ミルシート専用関数
// ========================================

/**
 * ミルシートかどうかを判定
 * @param {string} text - OCRテキスト
 * @returns {boolean}
 */
export function isMillsheet(text) {
  // まず、明らかに一般文書の場合は除外
  const nonMillsheetPatterns = [
    /御?見積書/u,
    /見積依頼/u,
    /請求書/u,
    /注文書/u,
    /発注書/u,
    /納品書/u,
    /領収書/u,
    /契約書/u,
    /報告書/u,
    /仕様書/u,
    /御中/u,
    /様$/um
  ];

  // 一般文書キーワードが見つかった場合はミルシートではない
  for (const pattern of nonMillsheetPatterns) {
    if (pattern.test(text)) {
      return false;
    }
  }

  // 強いミルシート指標（これらのいずれかがあればミルシート確定）
  const strongIndicators = [
    /ミルシート/i,
    /Mill\s*Sheet/i,
    /Mill\s*Certificate/i,
    /鋼材検査証明書/,
    /鋼材証明書/,
    /試験成績表/,
    /Test\s*Certificate/i,
    /製鋼番号/,
    /溶鋼番号/
  ];

  for (const indicator of strongIndicators) {
    if (indicator.test(text)) {
      return true;
    }
  }

  // 弱いミルシート指標（2つ以上必要）
  const weakIndicators = [
    /化学成分/,
    /機械的性質/,
    /Mechanical\s*Properties/i,
    /Chemical\s*Composition/i,
    /チャージ/,
    /Charge\s*No/i,
    /Heat\s*No/i,
    /製品証明書/
  ];

  let matchCount = 0;
  for (const indicator of weakIndicators) {
    if (indicator.test(text)) {
      matchCount++;
      if (matchCount >= 2) return true;
    }
  }

  // 製造元名 + 弱い指標1つ + 材質があればミルシートの可能性
  const hasMaterial = MATERIAL_PATTERNS.some(p => p.test(text));
  const hasManufacturer = MILLSHEET_MANUFACTURERS.some(m => text.includes(m));

  if (hasMaterial && hasManufacturer && matchCount >= 1) {
    return true;
  }

  return false;
}

/**
 * ミルシートから製造元を抽出（商社は除外）
 * @param {string} text - OCRテキスト
 * @returns {ExtractionResult}
 */
export function extractManufacturer(text) {
  // まず商社を除外リストとして保持
  const tradingCompaniesFound = [];
  for (const trading of MILLSHEET_TRADING_COMPANIES) {
    if (text.includes(trading)) {
      tradingCompaniesFound.push(trading);
    }
  }

  // 製造元を探す
  for (const manufacturer of MILLSHEET_MANUFACTURERS) {
    if (text.includes(manufacturer)) {
      return { value: manufacturer, raw: manufacturer };
    }
  }

  // 製造元が見つからない場合、商社を返す（ただし警告付き）
  if (tradingCompaniesFound.length > 0) {
    return {
      value: null,
      raw: `商社のみ検出: ${tradingCompaniesFound.join(', ')}`
    };
  }

  return { value: null, raw: null };
}

/**
 * ミルシートからチャージ番号（製鋼番号/溶鋼番号）を抽出
 * @param {string} text - OCRテキスト
 * @param {string|null} manufacturer - 検出された製造元（パターン特定用）
 * @returns {ExtractionResult}
 */
export function extractChargeNumber(text, manufacturer = null) {
  // 製造元が特定されている場合、そのパターンを優先
  if (manufacturer) {
    for (const cp of CHARGE_NUMBER_PATTERNS) {
      if (cp.manufacturer === manufacturer || cp.manufacturer === null) {
        const match = text.match(cp.pattern);
        if (match) {
          return { value: match[1], raw: match[0] };
        }
      }
    }
  }

  // 製造元不明の場合、全パターンを試す
  // 「製鋼番号」「溶鋼番号」「チャージ」などの近くの値を優先
  const chargeLabels = [
    /製鋼番号[:\s]*([A-Z0-9]{5,10})/i,
    /溶鋼番号[:\s]*([A-Z0-9]{5,10})/i,
    /チャージ[:\s]*([A-Z0-9]{5,10})/i,
    /Charge\s*No[.:\s]*([A-Z0-9]{5,10})/i,
    /Heat\s*No[.:\s]*([A-Z0-9]{5,10})/i,
    /鋼番[:\s]*([A-Z0-9]{5,10})/i
  ];

  for (const labelPattern of chargeLabels) {
    const match = text.match(labelPattern);
    if (match) {
      return { value: match[1], raw: match[0] };
    }
  }

  // ラベルなしでパターンマッチを試す
  for (const cp of CHARGE_NUMBER_PATTERNS) {
    const match = text.match(cp.pattern);
    if (match) {
      // 誤検出を避けるため、日付っぽいものは除外
      if (/^\d{8}$/.test(match[1]) || /^\d{4}[-/]\d{2}[-/]\d{2}$/.test(match[1])) {
        continue;
      }
      return { value: match[1], raw: match[0] };
    }
  }

  return { value: null, raw: null };
}

/**
 * ミルシートから厚みを抽出（寸法の最初の数字）
 * 例: 9×1524×3048 → 9t, 12.0×1524×3048 → 12t
 * @param {string} text - OCRテキスト
 * @returns {ExtractionResult}
 */
export function extractThickness(text) {
  // パターン1: 厚み×幅×長さ形式 (9×1524×3048, 9.0×1524×3048)
  const dimMatch = text.match(/(\d+(?:\.\d+)?)\s*[×xX]\s*\d+(?:\.\d+)?\s*[×xX]\s*\d+(?:\.\d+)?/);
  if (dimMatch) {
    const thickness = parseFloat(dimMatch[1]);
    // 小数点以下が0なら整数表示
    const thicknessStr = thickness % 1 === 0 ? String(Math.floor(thickness)) : String(thickness);
    return { value: `${thicknessStr}t`, raw: dimMatch[0] };
  }

  // パターン2: 厚さ/板厚 + 数値
  const thicknessLabelMatch = text.match(/(?:厚さ|板厚|厚み|t)[:\s]*(\d+(?:\.\d+)?)\s*(?:mm)?/i);
  if (thicknessLabelMatch) {
    const thickness = parseFloat(thicknessLabelMatch[1]);
    const thicknessStr = thickness % 1 === 0 ? String(Math.floor(thickness)) : String(thickness);
    return { value: `${thicknessStr}t`, raw: thicknessLabelMatch[0] };
  }

  // パターン3: 数字 + t (既に厚み表記されている場合)
  const tMatch = text.match(/(\d+(?:\.\d+)?)\s*t\b/i);
  if (tMatch) {
    const thickness = parseFloat(tMatch[1]);
    const thicknessStr = thickness % 1 === 0 ? String(Math.floor(thickness)) : String(thickness);
    return { value: `${thicknessStr}t`, raw: tMatch[0] };
  }

  return { value: null, raw: null };
}

/**
 * ミルシートからIssue Date（発行日）を抽出
 * ハンコ/スタンプの日付は除外
 * @param {string} text - OCRテキスト
 * @returns {ExtractionResult}
 */
export function extractMillsheetDate(text) {
  // 「発行日」「Date of Issue」などのラベル付き日付を優先
  const labelPatterns = [
    /発行日[:\s]*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/,
    /Date\s*of\s*Issue[:\s]*(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/i,
    /Issue\s*Date[:\s]*(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/i,
    /発行[:\s]*(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})/
  ];

  for (const pattern of labelPatterns) {
    const match = text.match(pattern);
    if (match) {
      const year = match[1];
      const month = String(parseInt(match[2], 10)).padStart(2, '0');
      const day = String(parseInt(match[3], 10)).padStart(2, '0');
      return { value: `${year}${month}${day}`, raw: match[0] };
    }
  }

  // ラベルなしの場合は通常の日付抽出を使用
  return extractDate(text);
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
 * ミルシート専用リネーム提案を生成
 * 形式: {発行日付}_{材質}_{厚み}_{メーカー名}_{チャージ番号}.pdf
 * @param {string} fullText - Full OCR text
 * @param {string} originalFilename - Original filename (for fallback)
 * @returns {RenameSuggestion}
 */
export function suggestMillsheetRename(fullText, originalFilename) {
  const reasons = [];
  let signalCount = 0;

  // 発行日を抽出
  const dateResult = extractMillsheetDate(fullText);
  let datePart = null;
  if (dateResult.value) {
    datePart = dateResult.value;
    reasons.push(`issue_date: ${dateResult.raw} -> ${dateResult.value}`);
    signalCount++;
  }

  // 材質を抽出
  const materialsResult = extractMaterials(fullText);
  let materialPart = null;
  if (materialsResult.value) {
    // 複数材質がある場合は最初の1つを使用
    materialPart = materialsResult.value.split('_')[0];
    reasons.push(`material: ${materialsResult.raw}`);
    signalCount++;
  }

  // 厚みを抽出
  const thicknessResult = extractThickness(fullText);
  let thicknessPart = null;
  if (thicknessResult.value) {
    thicknessPart = thicknessResult.value;
    reasons.push(`thickness: ${thicknessResult.raw} -> ${thicknessResult.value}`);
    signalCount++;
  }

  // 製造元を抽出
  const manufacturerResult = extractManufacturer(fullText);
  let manufacturerPart = null;
  if (manufacturerResult.value) {
    manufacturerPart = manufacturerResult.value;
    reasons.push(`manufacturer: ${manufacturerResult.value}`);
    signalCount++;
  } else if (manufacturerResult.raw) {
    // 商社のみ検出された場合は警告
    reasons.push(`warning: ${manufacturerResult.raw}`);
  }

  // チャージ番号を抽出
  const chargeResult = extractChargeNumber(fullText, manufacturerResult.value);
  let chargePart = null;
  if (chargeResult.value) {
    chargePart = chargeResult.value;
    reasons.push(`charge_no: ${chargeResult.raw} -> ${chargeResult.value}`);
    signalCount++;
  }

  // Confidence計算
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

  // ファイル名構築: {発行日付}_{材質}_{厚み}_{メーカー名}_{チャージ番号}
  let stem;
  if (signalCount === 0) {
    stem = originalFilename.replace(/\.[^.]+$/, '');
    reasons.push(`fallback: using original filename`);
  } else {
    const parts = [];
    if (datePart) parts.push(datePart);
    if (materialPart) parts.push(materialPart);
    if (thicknessPart) parts.push(thicknessPart);
    if (manufacturerPart) parts.push(manufacturerPart);
    if (chargePart) parts.push(chargePart);

    stem = parts.join('_');
  }

  stem = sanitizeFilename(stem);
  reasons.unshift('type: millsheet');

  return {
    stem,
    confidence,
    reasons
  };
}

/**
 * Generate rename suggestion from OCR text
 * @param {string} fullText - Full OCR text
 * @param {string} originalFilename - Original filename (for fallback)
 * @param {Object|null} llmExtraction - Optional LLM extraction result (2-model inference)
 * @param {string|null} llmExtraction.date - Date in YYYYMMDD format
 * @param {string|null} llmExtraction.docType - Document type
 * @param {string|null} llmExtraction.company - Company name
 * @param {string|null} llmExtraction.material - Material
 * @param {number} llmExtraction.confidence - Confidence 0.0-1.0
 * @returns {RenameSuggestion}
 */
export function suggestRename(fullText, originalFilename, llmExtraction = null) {
  // ミルシート判定
  if (isMillsheet(fullText)) {
    return suggestMillsheetRename(fullText, originalFilename);
  }

  const reasons = [];
  let signalCount = 0;

  // LLM抽出結果がある場合は優先使用
  const useLlm = llmExtraction && llmExtraction.confidence >= 0.5;
  if (useLlm) {
    reasons.push(`source: llm-2model (confidence=${llmExtraction.confidence})`);
  }

  // Extract date (LLM優先)
  let datePart = null;
  if (useLlm && llmExtraction.date) {
    datePart = llmExtraction.date;
    reasons.push(`date: llm -> ${llmExtraction.date}`);
    signalCount++;
  } else {
    const dateResult = extractDate(fullText);
    if (dateResult.value) {
      datePart = dateResult.value;
      reasons.push(`date: ${dateResult.raw} -> ${dateResult.value}`);
      signalCount++;
    }
  }

  // Extract document type (LLM優先)
  let docTypePart = null;
  if (useLlm && llmExtraction.docType) {
    docTypePart = llmExtraction.docType;
    reasons.push(`doc_type: llm -> ${llmExtraction.docType}`);
    signalCount++;
  } else {
    const docTypeResult = extractDocType(fullText);
    if (docTypeResult.value) {
      docTypePart = docTypeResult.value;
      reasons.push(`doc_type: ${docTypeResult.raw} -> ${docTypeResult.value}`);
      signalCount++;
    }
  }

  // Extract counterpart (LLM優先、自社名・社員名除外)
  let counterpartPart = null;
  if (useLlm && llmExtraction.company) {
    // LLM結果も自社名・社員名チェック
    if (!isSelfCompany(llmExtraction.company) && !isEmployeeName(llmExtraction.company)) {
      counterpartPart = llmExtraction.company;
      reasons.push(`counterpart: llm -> ${llmExtraction.company}`);
      signalCount++;
    }
  }
  if (!counterpartPart) {
    const counterpartResult = extractCounterpart(fullText);
    if (counterpartResult.value) {
      counterpartPart = counterpartResult.value;
      reasons.push(`counterpart: ${counterpartResult.raw} -> ${counterpartResult.value}`);
      signalCount++;
    }
  }

  // Extract materials (LLM優先)
  let materialsPart = null;
  if (useLlm && llmExtraction.material) {
    materialsPart = llmExtraction.material;
    reasons.push(`materials: llm -> ${llmExtraction.material}`);
    signalCount++;
  } else {
    const materialsResult = extractMaterials(fullText);
    if (materialsResult.value) {
      materialsPart = materialsResult.value;
      reasons.push(`materials: ${materialsResult.raw}`);
      signalCount++;
    }
  }

  // Extract item count or drawing numbers (ルールベースのみ)
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

  // Calculate confidence (LLM使用時はブースト)
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

  // LLM使用時は信頼度を少しブースト
  if (useLlm && confidence < 0.95) {
    confidence = Math.min(confidence + 0.1, 0.95);
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

/**
 * Unit tests for rename_suggest.js
 *
 * テスト要件:
 * 1. 同一入力は同一出力（deterministic）
 * 2. 空入力は安全なfallback（confidence低）
 * 3. 日興金属（自社名）は除外
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  extractDate,
  extractDocType,
  extractCounterpart,
  extractMaterials,
  extractItemCount,
  extractDrawingNumbers,
  isSelfCompany,
  sanitizeFilename,
  suggestRename
} from '../src/rename_suggest.js';

describe('extractDate', () => {
  it('extracts 令和 format', () => {
    const result = extractDate('令和6年1月30日');
    assert.strictEqual(result.value, '20240130');
    assert.strictEqual(result.raw, '令和6年1月30日');
  });

  it('extracts 令和 format with spaces', () => {
    const result = extractDate('令和 6 年 1 月 30 日');
    assert.strictEqual(result.value, '20240130');
  });

  it('extracts 令和8年 (2026)', () => {
    const result = extractDate('令和8年1月27日');
    assert.strictEqual(result.value, '20260127');
  });

  it('extracts 平成 format', () => {
    const result = extractDate('平成31年4月30日');
    assert.strictEqual(result.value, '20190430');
  });

  it('extracts YYYY年MM月DD日 format', () => {
    const result = extractDate('2024年1月30日');
    assert.strictEqual(result.value, '20240130');
  });

  it('extracts YYYY/MM/DD format', () => {
    const result = extractDate('2024/01/30');
    assert.strictEqual(result.value, '20240130');
  });

  it('extracts YYYY/M/D format (no padding)', () => {
    const result = extractDate('2024/1/5');
    assert.strictEqual(result.value, '20240105');
  });

  it('extracts YYYY-MM-DD format', () => {
    const result = extractDate('2024-01-30');
    assert.strictEqual(result.value, '20240130');
  });

  it('extracts R6.1.30 short format', () => {
    const result = extractDate('R6.1.30');
    assert.strictEqual(result.value, '20240130');
  });

  it('returns null for no date', () => {
    const result = extractDate('no date here');
    assert.strictEqual(result.value, null);
    assert.strictEqual(result.raw, null);
  });

  it('extracts first date when multiple exist', () => {
    const result = extractDate('令和6年1月30日\n2025/12/31');
    assert.strictEqual(result.value, '20240130');
  });
});

describe('extractDocType', () => {
  it('detects 見積書', () => {
    const result = extractDocType('御見積書');
    assert.strictEqual(result.value, '見積書');
    assert.strictEqual(result.raw, '御見積書');
  });

  it('detects 見積依頼', () => {
    const result = extractDocType('見積依頼書');
    assert.strictEqual(result.value, '見積依頼');
  });

  it('detects 請求書', () => {
    const result = extractDocType('請求書番号: 12345');
    assert.strictEqual(result.value, '請求書');
  });

  it('detects 注文書', () => {
    const result = extractDocType('注文書');
    assert.strictEqual(result.value, '注文書');
  });

  it('detects 発注書', () => {
    const result = extractDocType('発注書');
    assert.strictEqual(result.value, '発注書');
  });

  it('detects 納品書', () => {
    const result = extractDocType('納品書');
    assert.strictEqual(result.value, '納品書');
  });

  it('detects 領収書', () => {
    const result = extractDocType('領収書');
    assert.strictEqual(result.value, '領収書');
  });

  it('returns null for unknown type', () => {
    const result = extractDocType('some random text');
    assert.strictEqual(result.value, null);
  });
});

describe('isSelfCompany', () => {
  it('identifies 日興金属 as self company', () => {
    assert.strictEqual(isSelfCompany('日興金属'), true);
  });

  it('identifies 日興金属株式会社 as self company', () => {
    assert.strictEqual(isSelfCompany('日興金属株式会社'), true);
  });

  it('identifies 株式会社日興金属 as self company', () => {
    assert.strictEqual(isSelfCompany('株式会社日興金属'), true);
  });

  it('returns false for other companies', () => {
    assert.strictEqual(isSelfCompany('三八商店'), false);
    assert.strictEqual(isSelfCompany('株式会社テスト'), false);
  });

  it('returns false for null/empty', () => {
    assert.strictEqual(isSelfCompany(null), false);
    assert.strictEqual(isSelfCompany(''), false);
  });
});

describe('extractCounterpart', () => {
  it('extracts company before 御中', () => {
    const result = extractCounterpart('三八商店 御中');
    assert.strictEqual(result.value, '三八商店');
  });

  it('excludes 日興金属株式会社 (self company)', () => {
    const result = extractCounterpart('日興金属株式会社 御中');
    assert.strictEqual(result.value, null);
  });

  it('excludes 株式会社日興金属 (self company)', () => {
    const result = extractCounterpart('株式会社日興金属 御中');
    assert.strictEqual(result.value, null);
  });

  it('extracts name before 様', () => {
    const result = extractCounterpart('山田太郎 様');
    assert.strictEqual(result.value, '山田太郎');
  });

  it('extracts 株式会社 pattern without suffix', () => {
    const result = extractCounterpart('株式会社テスト商事');
    assert.strictEqual(result.value, '株式会社テスト商事');
  });

  it('extracts company name ending with 株式会社', () => {
    const result = extractCounterpart('テスト工業株式会社');
    assert.strictEqual(result.value, 'テスト工業株式会社');
  });

  it('extracts 有限会社 pattern', () => {
    const result = extractCounterpart('有限会社ツダ');
    assert.strictEqual(result.value, '有限会社ツダ');
  });

  it('returns null for no counterpart', () => {
    const result = extractCounterpart('random text without names');
    assert.strictEqual(result.value, null);
  });
});

describe('extractMaterials', () => {
  it('extracts SS400', () => {
    const result = extractMaterials('材質: SS400');
    assert.strictEqual(result.value, 'SS400');
  });

  it('extracts multiple materials', () => {
    const result = extractMaterials('SS400 と SUS304 の板');
    assert.ok(result.value.includes('SS400'));
    assert.ok(result.value.includes('SUS304'));
  });

  it('extracts SM400A/B/C variants', () => {
    const result = extractMaterials('SM400B t=12');
    assert.strictEqual(result.value, 'SM400B');
  });

  it('extracts aluminum materials', () => {
    const result = extractMaterials('A5052 P');
    assert.strictEqual(result.value, 'A5052');
  });

  it('is case insensitive', () => {
    const result = extractMaterials('ss400');
    assert.strictEqual(result.value, 'SS400');
  });

  it('returns null for no materials', () => {
    const result = extractMaterials('random text');
    assert.strictEqual(result.value, null);
  });
});

describe('extractItemCount', () => {
  it('extracts 点 count', () => {
    const result = extractItemCount('合計 5点');
    assert.strictEqual(result.value, '5点');
  });

  it('extracts 品目 count', () => {
    const result = extractItemCount('14品目');
    assert.strictEqual(result.value, '14品目');
  });

  it('extracts 枚 count', () => {
    const result = extractItemCount('3枚');
    assert.strictEqual(result.value, '3枚');
  });

  it('sums multiple counts', () => {
    const result = extractItemCount('2枚 + 3枚');
    assert.strictEqual(result.value, '5枚');
  });

  it('returns null for no count', () => {
    const result = extractItemCount('no count here');
    assert.strictEqual(result.value, null);
  });
});

describe('extractDrawingNumbers', () => {
  it('extracts single drawing number', () => {
    const result = extractDrawingNumbers('図面番号 205-88671');
    assert.strictEqual(result.value, '205-88671');
  });

  it('extracts multiple drawing numbers (up to 2)', () => {
    const result = extractDrawingNumbers('205-88671 と 206-12345');
    assert.ok(result.value.includes('205-88671'));
    assert.ok(result.value.includes('206-12345'));
  });

  it('summarizes many drawing numbers', () => {
    const result = extractDrawingNumbers('205-88671, 206-12345, 207-54321, 208-11111');
    assert.strictEqual(result.value, '4図面');
  });

  it('returns null for no drawing numbers', () => {
    const result = extractDrawingNumbers('no drawing numbers');
    assert.strictEqual(result.value, null);
  });
});

describe('sanitizeFilename', () => {
  it('replaces forbidden characters', () => {
    const result = sanitizeFilename('file/name:test*?');
    assert.strictEqual(result, 'file_name_test');
  });

  it('replaces whitespace with underscore', () => {
    const result = sanitizeFilename('file name with spaces');
    assert.strictEqual(result, 'file_name_with_spaces');
  });

  it('collapses consecutive underscores', () => {
    const result = sanitizeFilename('a__b___c');
    assert.strictEqual(result, 'a_b_c');
  });

  it('removes leading/trailing dots and underscores', () => {
    const result = sanitizeFilename('..._test_...');
    assert.strictEqual(result, 'test');
  });

  it('handles Windows reserved names', () => {
    const result = sanitizeFilename('CON');
    assert.strictEqual(result, '_CON');
  });

  it('truncates long filenames', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeFilename(longName);
    assert.strictEqual(result.length, 200);
  });

  it('returns untitled for empty input', () => {
    assert.strictEqual(sanitizeFilename(''), 'untitled');
    assert.strictEqual(sanitizeFilename(null), 'untitled');
    assert.strictEqual(sanitizeFilename(undefined), 'untitled');
  });

  it('returns untitled for input that becomes empty after sanitization', () => {
    const result = sanitizeFilename('...');
    assert.strictEqual(result, 'untitled');
  });
});

describe('suggestRename', () => {
  it('is deterministic - same input produces same output', () => {
    const text = '令和6年1月30日 御見積書 三八商店 御中';
    const result1 = suggestRename(text, 'test.pdf');
    const result2 = suggestRename(text, 'test.pdf');

    assert.strictEqual(result1.stem, result2.stem);
    assert.strictEqual(result1.confidence, result2.confidence);
    assert.deepStrictEqual(result1.reasons, result2.reasons);
  });

  it('calculates confidence 0.9 with 3 signals', () => {
    const text = '令和6年1月30日 御見積書 三八商店 御中';
    const result = suggestRename(text, 'test.pdf');

    assert.strictEqual(result.confidence, 0.9);
    assert.strictEqual(result.stem, '20240130_見積書_三八商店');
    assert.strictEqual(result.reasons.length, 3);
  });

  it('calculates confidence 0.95 with 4+ signals', () => {
    const text = '令和6年1月30日 見積依頼 三八商店 御中 SS400 3枚';
    const result = suggestRename(text, 'test.pdf');

    assert.strictEqual(result.confidence, 0.95);
    assert.ok(result.stem.includes('SS400'));
    assert.ok(result.stem.includes('3枚'));
  });

  it('calculates confidence 0.7 with 2 signals', () => {
    const text = '令和6年1月30日 御見積書';
    const result = suggestRename(text, 'test.pdf');

    assert.strictEqual(result.confidence, 0.7);
    assert.strictEqual(result.stem, '20240130_見積書');
    assert.strictEqual(result.reasons.length, 2);
  });

  it('calculates confidence 0.4 with 1 signal', () => {
    const text = '令和6年1月30日';
    const result = suggestRename(text, 'test.pdf');

    assert.strictEqual(result.confidence, 0.4);
    assert.strictEqual(result.stem, '20240130');
    assert.strictEqual(result.reasons.length, 1);
  });

  it('uses fallback for empty input (confidence 0.1)', () => {
    const result = suggestRename('', 'original.pdf');

    assert.strictEqual(result.confidence, 0.1);
    assert.strictEqual(result.stem, 'original');
    assert.ok(result.reasons.some(r => r.includes('fallback')));
  });

  it('uses fallback for no signals', () => {
    const result = suggestRename('random text with no patterns', 'myfile.pdf');

    assert.strictEqual(result.confidence, 0.1);
    assert.strictEqual(result.stem, 'myfile');
  });

  it('sanitizes the output stem', () => {
    const text = '2024/01/30 請求書 テスト/商事 御中';
    const result = suggestRename(text, 'test.pdf');

    // Should not contain slashes
    assert.ok(!result.stem.includes('/'));
  });

  it('excludes 日興金属 from counterpart', () => {
    const text = '令和6年1月30日 見積依頼 日興金属株式会社 御中';
    const result = suggestRename(text, 'test.pdf');

    // Should not include 日興金属
    assert.ok(!result.stem.includes('日興金属'));
    // But should still have date and doc type
    assert.ok(result.stem.includes('20240130'));
    assert.ok(result.stem.includes('見積依頼'));
  });

  it('includes materials in filename', () => {
    const text = '令和6年1月30日 見積依頼 材質: SS400 SUS304';
    const result = suggestRename(text, 'test.pdf');

    assert.ok(result.stem.includes('SS400'));
    assert.ok(result.reasons.some(r => r.includes('materials')));
  });

  it('includes item count in filename', () => {
    const text = '令和6年1月30日 注文書 合計 14品目';
    const result = suggestRename(text, 'test.pdf');

    assert.ok(result.stem.includes('14品目'));
    assert.ok(result.reasons.some(r => r.includes('item_count')));
  });
});

describe('Integration scenarios', () => {
  it('handles typical Japanese invoice (excluding self company)', () => {
    const text = `
      令和6年1月30日

      御見積書

      日興金属株式会社 御中

      下記の通りお見積り申し上げます。
      SS400 t=12 5枚
      合計金額: ¥100,000
    `;

    const result = suggestRename(text, 'fax001.pdf');

    // 日興金属は除外されるべき
    assert.ok(!result.stem.includes('日興金属'));
    assert.ok(result.stem.includes('20240130'));
    assert.ok(result.stem.includes('見積書'));
    assert.ok(result.stem.includes('SS400'));
  });

  it('handles order document with materials', () => {
    const text = `
      2024年2月15日

      注文書

      株式会社テスト工業 様

      品名: SS400 板
      数量: 10枚
    `;

    const result = suggestRename(text, 'fax002.pdf');

    assert.ok(result.confidence >= 0.9);
    assert.ok(result.stem.includes('20240215'));
    assert.ok(result.stem.includes('注文書'));
    assert.ok(result.stem.includes('SS400'));
  });

  it('handles FAX with drawing numbers', () => {
    const text = `
      令和8年1月29日
      見積依頼
      有限会社ツダ 御中
      図面番号: 205-88671
    `;

    const result = suggestRename(text, 'fax003.pdf');

    assert.ok(result.stem.includes('20260129'));
    assert.ok(result.stem.includes('見積依頼'));
    assert.ok(result.stem.includes('有限会社ツダ'));
    assert.ok(result.stem.includes('205-88671'));
  });

  it('handles complex FAX with multiple materials', () => {
    const text = `
      令和8年1月29日
      見積依頼
      有限会社ツダ 御中
      SS400 t=12 2枚
      SM400B t=40 3枚
      SUS304 t=3 5枚
      合計 10枚
    `;

    const result = suggestRename(text, 'fax004.pdf');

    assert.strictEqual(result.confidence, 0.95);
    assert.ok(result.stem.includes('SS400'));
    assert.ok(result.stem.includes('SM400B'));
    assert.ok(result.stem.includes('SUS304'));
    // 2+3+5+10 = 20枚 (全ての数量が合計される)
    assert.ok(result.stem.includes('20枚'));
  });
});

# 汎用OCRリネーマー (Claude Code専用)

PDFや画像をOCRで読み取り、内容に基づいてファイル名を提案・リネームする。

---

## 実行環境

- **実行環境**: Node.js (クロスプラットフォーム)
- **プロジェクト**: `fax-ocr-js/`
- **エントリポイント**: `node src/main.js`
- **設定ファイル**: `.env` (APIキー必須)

### 必要な環境変数

```bash
GOOGLE_CLOUD_API_KEY=your_google_cloud_api_key  # 必須
GEMINI_API_KEY=your_gemini_api_key              # --gemini 使用時
```

### 日本語フォント (searchable PDF用)

| OS | パス |
|----|------|
| Windows | `C:\Windows\Fonts\msgothic.ttc` |
| macOS | `/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc` |
| Linux | `/usr/share/fonts/truetype/fonts-japanese-gothic.ttf` |

---

## 基本コマンド

### 単一ファイル処理 (process コマンド)

```bash
node src/main.js process \
    --in "{入力ファイル}" \
    --out "{出力フォルダ}" \
    --gemini \
    --searchable-pdf \
    --font-path "{フォントパス}"
```

### パラメータ

| パラメータ | 説明 | 必須 |
|-----------|------|------|
| `--in` | 入力ファイル（PDF/画像） | ✅ |
| `--out` | 出力フォルダ | ✅ |
| `--gemini` | Gemini APIでMarkdown整形 | ❌ |
| `--searchable-pdf` | 透明テキスト付きPDF生成 | ❌ |
| `--font-path` | 日本語フォント | ⚠️ searchable-pdf使用時は必須 |
| `--skip-ocr` | 既存.ocr.jsonを再利用 | ❌ |
| `--dpi` | PDF変換DPI (default: 300) | ❌ |
| `--force` | キャッシュを無視して再OCR | ❌ |

---

## JSON出力フォーマット

`process` コマンドは標準出力にJSON形式で結果を返す：

```json
{
  "status": "ok",
  "input_file": "./fax.pdf",
  "job_dir": "./output",
  "ocr_json": "./output/fax.ocr.json",
  "rename_json": "./output/fax.rename.json",
  "gemini_md": "./output/fax.gemini.md",
  "searchable_pdf": "./output/fax.searchable.pdf",
  "rename": {
    "stem": "20260129_見積依頼_有限会社ツダ_SM400B_SS400_14品目",
    "confidence": 0.95,
    "reasons": [
      "date: 令和8年1月29日 -> 20260129",
      "doc_type: 見積依頼",
      "counterpart: 有限会社ツダ",
      "materials: SM400B, SS400",
      "item_count: 14品目"
    ]
  }
}
```

### 出力ファイル

| ファイル | 説明 |
|----------|------|
| `*.ocr.json` | OCR結果（bbox付き） |
| `*.rename.json` | リネーム提案 |
| `*.gemini.md` | Gemini整形後のMarkdown |
| `*.searchable.pdf` | 透明テキスト付きPDF |

---

## 自動リネームロジック

### 抽出項目

| 項目 | パターン | 例 |
|------|----------|-----|
| 日付 | 令和X年Y月Z日, YYYY/MM/DD | `20260129` |
| 書類種別 | 見積依頼/注文書/納品書 等 | `見積依頼` |
| 宛先 | 〇〇御中, 〇〇様 | `有限会社ツダ` |
| 材質 | SS400, SM400A/B/C, SUS304 等 | `SM400B_SS400` |
| 点数 | ○枚, ○本, ○点, ○品目 | `14品目` |
| 図面番号 | XXX-XXXXX形式 | `205-88671` |

### Confidence スコア

| 抽出数 | Confidence |
|--------|------------|
| 4項目以上 | 0.95 |
| 3項目 | 0.9 |
| 2項目 | 0.7 |
| 1項目 | 0.4 |
| 0項目 | 0.1 |

### 自社名除外ルール

**重要**: `日興金属` は自社名なので会社名として採用しない

```
❌ 20260127_見積依頼_日興金属_SS400.pdf
✅ 20260127_見積依頼_三八商店_SS400.pdf
```

### ファイル名フォーマット

```
{日付}_{種別}_{会社名}_{材質}_{点数}.pdf
```

例:
```
元: 2026-01-27_FAX_富陽金属株式会社.pdf
後: 20260127_見積依頼_三八商店_SS400_3点.pdf
```

---

## 処理手順

### 1. 入力確認

```bash
# フォルダ内のPDF/画像を確認
ls -la "{フォルダパス}"/*.pdf "{フォルダパス}"/*.jpg "{フォルダパス}"/*.png 2>/dev/null
```

### 2. OCR実行

```bash
# 単一ファイル処理
cd /path/to/fax-ocr-js
node src/main.js process \
    --in "/path/to/input.pdf" \
    --out "./output" \
    --gemini \
    --searchable-pdf \
    --font-path "/path/to/font.ttc"
```

### 3. 結果確認

```bash
# OCR結果を確認
cat ./output/input.ocr.json | jq '.raw_text'

# リネーム提案を確認
cat ./output/input.rename.json | jq '.'

# Gemini整形結果を確認
cat ./output/input.gemini.md
```

### 4. リネーム実行

```bash
# 提案に従ってリネーム
mv "/path/to/input.pdf" "/path/to/20260129_見積依頼_有限会社ツダ_SM400B_SS400_14品目.pdf"
```

---

## バッチ処理

### フォルダ内の全ファイルを処理

```bash
cd /path/to/fax-ocr-js
node src/main.js --in "./input" --out "./output"
```

### シェルスクリプトでの一括処理

```bash
#!/bin/bash
INPUT_DIR="./faxes"
OUTPUT_DIR="./output"

for file in "$INPUT_DIR"/*.pdf; do
    echo "Processing: $file"
    result=$(node src/main.js process --in "$file" --out "$OUTPUT_DIR" --gemini)

    # JSON結果をパース
    stem=$(echo "$result" | jq -r '.rename.stem')
    confidence=$(echo "$result" | jq -r '.rename.confidence')

    echo "  Suggestion: $stem (confidence: $confidence)"

    # confidence >= 0.7 なら自動リネーム
    if (( $(echo "$confidence >= 0.7" | bc -l) )); then
        ext="${file##*.}"
        mv "$file" "$INPUT_DIR/${stem}.${ext}"
        echo "  Renamed!"
    fi
done
```

---

## データ抽出ルール

### 表形式データの列順（優先順位順）

**パターン1（詳細版）:**
```
図面番号 → 品番 → 材質 → 板厚 → 幅 → 長さ → 数量 → 摘要
```

**パターン2（簡易版）:**
```
板厚 → 寸法1 → 寸法2 → 数量 → 単位
```

### 数値と単位の分離ルール

| 元の表記 | 板厚 | 寸法1 | 寸法2 | 数量 | 単位 |
|---------|------|-------|-------|------|------|
| 40t×2195φ×390φ | 40 | 2195 | 390 | - | φ |
| 19t*529*500 | 19 | 529 | 500 | - | - |
| 6t×38×686 4本 | 6 | 38 | 686 | 4 | 本 |
| Φ12×100 2個 | - | Φ12 | 100 | 2 | 個 |

---

## 使用例

### 例1: 単一ファイル処理

```
User: "このPDFをOCRしてリネームして"
Claude: [node src/main.js process 実行]
Claude: "提案ファイル名: 20260129_見積依頼_有限会社ツダ_SM400B_SS400_14品目.pdf (confidence: 0.95)"
User: "OK"
Claude: [mv でリネーム実行]
```

### 例2: フォルダ一括処理

```
User: "このフォルダ全部OCRして適切な名前に変えて"
Claude: [ファイル一覧取得] "15件のPDFが見つかりました"
Claude: [1件目処理] "提案: 20260129_見積依頼_有限会社ツダ... (confidence: 0.95)"
User: "このルールで全部やって"
Claude: [残り14件を自動処理]
```

### 例3: データ抽出

```
User: "このPDFの明細データを表にして"
Claude: [OCR実行 + gemini.md を読み込み]
Claude: [表形式で表示]

| 図面番号 | 品番 | 材質 | 板厚 | 寸法1 | 寸法2 | 数量 | 単位 |
|---------|------|------|------|-------|-------|------|------|
| 205-88671 | ①-1 | SM400B | 40 | 2195 | 390 | 2 | 枚 |
```

### 例4: 既存OCRからSearchable PDFのみ生成

```bash
node src/main.js process \
    --in "./fax.pdf" \
    --out "./output" \
    --skip-ocr \
    --searchable-pdf \
    --font-path "/path/to/font.ttc"
```

---

## 注意事項

- **APIキー必須**: `.env` に `GOOGLE_CLOUD_API_KEY` を設定
- **Python依存**: `--gemini` や `--searchable-pdf` 使用時は `pip install -r py/requirements.txt`
- **日本語フォント**: searchable PDF生成には日本語フォントが必須
- **confidence値**: 0.5未満の場合は手動確認を推奨
- **自社名除外**: リネーム時に「日興金属」は会社名として使用しない
- **キャッシュ**: 同じファイルの再OCRはスキップされる（`--force` で強制再実行）

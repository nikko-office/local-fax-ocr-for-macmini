# FaxOCR-JS

FAX受信PDF/画像を Google Vision API で OCR し、リネーム候補を提案する Node.js ツール。

Rust版 faxocr の設計思想（再現性・bbox保持・提案型リネーム）を継承しています。

## 特徴

- **再現性**: OCR結果は「資産」として保存、再OCRを前提にしない
- **bbox保持**: 座標情報を保持（後段の帳票アドオンに必須）
- **安全設計**: リネームは「提案」のみ、自動適用はオプション
- **エラー明示**: サイレントフォールバック禁止
- **Searchable PDF**: 透明テキストレイヤー付きPDF生成（Python/PyMuPDF連携）
- **Gemini整形**: OCR結果をGemini APIでMarkdown整形（オプション）
- **自社名除外**: 日興金属（自社）はリネーム提案から除外

## 必要環境

### Node.js

- Node.js 18.0.0 以上

### Python (オプション)

Searchable PDF生成やGemini整形を使用する場合:

- Python 3.8 以上
- PyMuPDF (`pip install PyMuPDF`)
- google-generativeai (`pip install google-generativeai`) ※Gemini使用時のみ

```bash
# Python依存パッケージのインストール
pip install -r py/requirements.txt
```

### 外部ツール

PDF変換に `pdftocairo` (Poppler) が必要です。

**Ubuntu/Debian:**
```bash
sudo apt install -y poppler-utils
```

**macOS:**
```bash
brew install poppler
```

**Windows:**
[Poppler for Windows](https://github.com/oschwartz10612/poppler-windows/releases) から取得してPATHに追加

### 環境変数

```bash
# 必須: Google Cloud Vision API キー
export GOOGLE_CLOUD_API_KEY="your_google_cloud_api_key"

# オプション: Gemini API キー (--gemini 使用時)
export GEMINI_API_KEY="your_gemini_api_key"
```

## セットアップ

```bash
# リポジトリをクローン
cd fax-ocr-js

# 依存パッケージをインストール
npm install

# 環境変数を設定
cp .env.example .env
# .env を編集して API キーを設定
```

## 使い方

### バッチ処理（フォルダ内の全ファイル）

```bash
# input/ フォルダ内のPDF/画像をOCR
node src/main.js

# 入力/出力ディレクトリを指定
node src/main.js --in ./my_faxes --out ./results
```

### 単一ファイル処理（JSON出力）

```bash
# 単一ファイルをOCR処理（結果はJSON形式で出力）
node src/main.js process --in ./fax.pdf --out ./output

# Gemini整形 + Searchable PDF生成
node src/main.js process --in ./fax.pdf --out ./output \
  --gemini --searchable-pdf --font-path /path/to/font.ttf
```

### オプション

```
Options:
  --in <path>         入力ファイル/ディレクトリ (default: ./input)
  --out <dir>         出力ディレクトリ (default: ./output)
  --apply-rename      リネーム提案を実際に適用する
  --force             キャッシュを無視して再OCR
  --dpi <number>      PDF変換時のDPI (default: 300)
  --skip-ocr          既存の.ocr.jsonがあれば再利用
  --gemini            Gemini APIでMarkdown整形を実行
  --searchable-pdf    透明テキスト重畳のPDFを生成
  --font-path <path>  日本語フォントファイルパス（searchable-pdf用）
  -h, --help          ヘルプを表示
  -v, --version       バージョンを表示
```

### 実行例

```bash
# 1. テストファイルを配置
cp sample.pdf input/

# 2. OCR実行
node src/main.js

# 3. 出力確認
ls output/
# sample.ocr.json    - OCR結果（bbox付き）
# sample.rename.json - リネーム提案
# sample.sha256      - キャッシュ用ハッシュ

# 4. リネーム提案を確認
cat output/sample.rename.json
# {
#   "stem": "20240130_見積書_三八商店",
#   "confidence": 0.9,
#   "reasons": [...]
# }

# 5. リネームを適用する場合
node src/main.js --apply-rename
```

### Searchable PDF生成

```bash
# OCR結果からSearchable PDFを生成
node src/main.js process --in ./fax.pdf --out ./output \
  --searchable-pdf --font-path "C:\Windows\Fonts\msgothic.ttc"

# 既存OCR結果を再利用してSearchable PDFのみ生成
node src/main.js process --in ./fax.pdf --out ./output \
  --skip-ocr --searchable-pdf --font-path "/path/to/font.ttf"
```

### Gemini Markdown整形

```bash
# OCR + Gemini整形
node src/main.js process --in ./fax.pdf --out ./output --gemini

# 出力: sample.gemini.md
```

## 出力ファイル

| ファイル | 説明 |
|----------|------|
| `<stem>.ocr.json` | OCR結果（bbox付き正規化JSON） |
| `<stem>.rename.json` | リネーム提案（stem/confidence/reasons） |
| `<stem>.sha256` | 入力ファイルのハッシュ（キャッシュ用） |
| `<stem>.png` | PDF変換後の画像（PDF入力時のみ） |
| `<stem>.gemini.md` | Gemini整形後のMarkdown（--gemini使用時） |
| `<stem>.searchable.pdf` | 透明テキスト付きPDF（--searchable-pdf使用時） |

## OCR結果スキーマ

```json
{
  "schema_version": "1.0.0",
  "source_file": "fax_001.pdf",
  "source_sha256": "abc123...",
  "ocr_engine": "google_vision",
  "created_at": "2024-01-30T10:30:00.000Z",
  "raw_text": "全文テキスト...",
  "pages": [{
    "page_index": 0,
    "width": 2480,
    "height": 3508,
    "blocks": [{
      "id": "blk_a1b2c3d4-...",
      "bbox": {"x0": 100, "y0": 50, "x1": 500, "y1": 100},
      "lines": [{
        "id": "ln_e5f6g7h8-...",
        "text": "御見積書",
        "bbox": {"x0": 100, "y0": 50, "x1": 500, "y1": 80},
        "tokens": [{
          "id": "tok_i9j0k1l2-...",
          "text": "御見積書",
          "bbox": {"x0": 100, "y0": 50, "x1": 300, "y1": 80},
          "confidence": 0.98
        }]
      }]
    }]
  }]
}
```

### 座標系

- **原点**: 左上 (0, 0)
- **X軸**: 右方向が正
- **Y軸**: 下方向が正
- **単位**: ピクセル

## リネーム提案

### 抽出対象

| フィールド | パターン例 |
|-----------|-----------|
| 日付 | 令和X年Y月Z日, YYYY/MM/DD, YYYY-MM-DD |
| 書類種別 | 請求書, 見積書, 注文書, 納品書 等 |
| 宛先 | 〇〇御中, 〇〇様（日興金属は除外） |
| 材質 | SS400, SM400A/B/C, SUS304, SPHC, A5052 等 |
| 点数 | ○枚, ○本, ○点, ○品目 |
| 図面番号 | 205-88671 形式 |

### 自社名除外ルール

`日興金属`（自社名）は宛先として採用しません。

```
❌ 20260129_見積依頼_日興金属_SS400.pdf
✅ 20260129_見積依頼_三八商店_SS400.pdf
```

### Confidence スコア

| 抽出数 | Confidence |
|--------|------------|
| 4項目以上 | 0.95 |
| 3項目 | 0.9 |
| 2項目 | 0.7 |
| 1項目 | 0.4 |
| 0項目 | 0.1 (フォールバック) |

### 出力形式

```json
{
  "stem": "20260129_見積依頼_有限会社ツダ_SM400B_SS400_14品目",
  "confidence": 0.95,
  "reasons": [
    "date: 令和8年1月29日 -> 20260129",
    "doc_type: 見積依頼",
    "counterpart: 有限会社ツダ 御中 -> 有限会社ツダ",
    "materials: SM400B, SS400",
    "item_count: 14品目"
  ]
}
```

### process コマンドのJSON出力

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
    "reasons": [...]
  }
}
```

## テスト

```bash
# ユニットテスト実行
npm test

# または
node --test tests/
```

## Web GUI

ブラウザベースのGUIも利用可能です。

```bash
# GUI サーバーを起動
npm run gui

# または
node src/gui.js --port 3000
```

ブラウザで http://localhost:3000 にアクセスすると、ドラッグ＆ドロップでファイルをアップロードしてOCR処理できます。

### GUI機能

- ファイルのドラッグ＆ドロップ
- OCRオプション設定（DPI、Gemini整形、Searchable PDF）
- リネーム提案の表示と適用
- 出力ファイルのダウンロード

## 処理フロー

```
Input (PDF/PNG/JPG)
       │
       ▼
┌─────────────────┐
│  PDF→PNG変換    │  pdftocairo (必要時のみ)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  ハッシュチェック │  SHA256 (キャッシュ)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Vision API     │  documentTextDetection
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  正規化         │  OcrDocument (bbox保持)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  リネーム提案    │  日付/種別/宛先/材質/点数
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼ (オプション)
┌───────┐  ┌─────────────────┐
│ 出力  │  │  Gemini整形     │  Python → Markdown
└───────┘  └────────┬────────┘
                    │
                    ▼ (オプション)
             ┌─────────────────┐
             │ Searchable PDF  │  Python (PyMuPDF)
             └─────────────────┘

出力ファイル:
  .ocr.json, .rename.json, .gemini.md, .searchable.pdf
```

## ライセンス

MIT License

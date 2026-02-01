---
name: fax-ocr
description: FAX・PDF・ミルシートのOCR処理とリネーム。完全オフライン運用。OCR、ファイル名提案、透明テキストPDF生成。
---

# FAX OCR リネーマー（完全オフライン）

PDFや画像をOCRで読み取り、内容に基づいてファイル名を提案・リネームする。
**外部APIは使用しません。**

## 詳細スキル

このフォルダには詳細なスキルドキュメントがあります：

- [faxocr_skill.md](../../../faxocr_skill.md) - 汎用OCRリネーマー（メイン）
- [millsheet_skill.md](../../../millsheet_skill.md) - ミルシート専用リネーム
- [auto-rename](../auto-rename/SKILL.md) - 自動リネームエージェント（無人処理用）

## クイックリファレンス

### 実行環境

- **実行環境**: Node.js + Docker
- **エントリポイント**: `node src/main.js`
- **OCRエンジン**: PaddleOCR (Docker)

### 前提条件（初回のみ）

```bash
# PaddleOCR API を起動
docker-compose up -d

# 動作確認
curl http://localhost:8765/health
```

### 基本コマンド

```bash
# 単一ファイル処理
node src/main.js process \
    --in "{入力ファイル}" \
    --out "{出力フォルダ}"

# フォルダ一括処理
node src/main.js --in "./input" --out "./output"

# ミルシート専用
node src/millsheet_batch_rename.js \
    --ocr-dir "./output/millsheet" \
    --source-dir "/path/to/millsheets"
```

### 主要パラメータ

| パラメータ | 説明 |
|-----------|------|
| `--in` | 入力ファイル/フォルダ |
| `--out` | 出力フォルダ |
| `--gemini` | Gemini APIでMarkdown整形 |
| `--searchable-pdf` | 透明テキスト付きPDF生成 |
| `--font-path` | 日本語フォント（searchable-pdf時必須） |
| `--skip-ocr` | 既存.ocr.jsonを再利用 |
| `--force` | キャッシュを無視して再OCR |

### 出力ファイル

| ファイル | 説明 |
|----------|------|
| `*.ocr.json` | OCR結果（bbox付き） |
| `*.rename.json` | リネーム提案 |
| `*.gemini.md` | Gemini整形後のMarkdown |
| `*.searchable.pdf` | 透明テキスト付きPDF |

### ファイル名ルール（一般文書）

```
{伝票の種類}_{送られた日時}_{送り先}_{その他情報}.pdf
```

例: `見積依頼_20260129_有限会社ツダ_SM400B_SS400_14品目.pdf`

**重要**: `日興金属` は自社名なので送り先として採用しない

### ファイル名ルール（ミルシート）

```
{発行日付}_{材質}_{厚み}_{メーカー名}_{チャージ番号}.pdf
```

例: `20240411_SS400_9t_中山製鋼所_48D7503.pdf`

| 項目 | ルール |
|------|--------|
| 発行日付 | ミルシート本体の発行日（ハンコ/スタンプは不可） |
| 材質 | JIS規格 (SS400, SM400A/B/C等) |
| 厚み | 寸法の最初の数字 + t |
| メーカー名 | **製造元**（商社は不可） |
| チャージ番号 | 製鋼番号/溶鋼番号 |

**製造元 vs 商社:**
- 採用: 東京製鉄, 中山製鋼所, JFEスチール, 神戸製鋼所, 日本製鉄
- 不可: 小野建, 中山通商, 岡本鋼材, 阪和興業, 日興金属

### Confidence スコア

| 抽出数 | Confidence |
|--------|------------|
| 4項目以上 | 0.95 |
| 3項目 | 0.9 |
| 2項目 | 0.7 |
| 1項目 | 0.4 |
| 0項目 | 0.1 |

0.5未満の場合は手動確認を推奨。

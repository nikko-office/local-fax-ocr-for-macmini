# Changelog

## [0.2.0] - 2026-01-29

### Added
- **Searchable PDF (ASCII)**: `--searchable-pdf` フラグで画像+透明テキストレイヤーの検索可能PDFを生成
- **Searchable PDF (CJK/Unicode)**: `--font-path` で TrueType フォントを指定すると Type0 (CIDFontType2 + Identity-H + ToUnicode CMap) で日本語テキストを埋め込み
- CLI オプション: `--searchable-pdf`, `--font-path`, `--font-postscript-name`
- `searchable_pdf` ライブラリ API: `build()`, `build_from_image_pdf()`, `build_with_font()`, `build_from_image_pdf_with_font()`
- `rename_suggest` モジュール: OCR結果からファイル名を推定
- `ttf-parser` 依存追加（フォント名自動抽出）

### Notes
- 破壊的変更なし（0.1.0 の CLI / lib API はすべて互換）
- PDF入力時は前段正規化が前提（1ページ、回転なし、MediaBoxのみ、DCTDecode画像）

## [0.1.0] - Initial release

### Added
- Google Cloud Vision OCR
- Gemini Markdown 整形
- bbox fill（実験的）
- GUI モード
- CLI モード (`faxocr run`)

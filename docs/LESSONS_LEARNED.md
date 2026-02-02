# Searchable PDF 生成の教訓 (2026-02-02)

## 問題1: テキスト選択がページ全体をハイライトする

### 原因
- `TextWriter` を使用すると、全テキストが1つの text object になる
- PDF仕様上、1つの BT...ET ブロック内のテキストは連続選択される

### 解決策
- **行ごとに独立した `insert_text` 呼び出し** を使用
- 各行が独立した text object (BT...ET) になる

```python
# NG: TextWriterは全テキストを1つのオブジェクトにする
tw = fitz.TextWriter(page.rect)
for line in lines:
    tw.append(...)
tw.write_text(page)

# OK: insert_textは呼び出しごとに独立したオブジェクト
for line in lines:
    page.insert_text(point, text, render_mode=3)
```

## 問題2: PNG入力でエラー「is no PDF」

### 原因
- `fitz.open()` でPNGを開くと、PDF操作（insert_text等）が使えない
- PyMuPDFは画像を「image document」として扱う

### 解決策
- PNG/JPEG入力時は、まず新規PDFを作成して画像を埋め込む

```python
if input_path.suffix.lower() in ['.png', '.jpg', '.jpeg']:
    with open(input_file, 'rb') as f:
        img_data = f.read()

    pix = fitz.Pixmap(input_file)
    img_width, img_height = pix.width, pix.height

    doc = fitz.open()  # 新規PDF
    pdf_page = doc.new_page(width=page_width, height=page_height)
    pdf_page.insert_image(pdf_page.rect, stream=img_data)
```

## 問題3: ファイルサイズが巨大（5-7MB）

### 原因
- PyMuPDFの `insert_image` はPNG圧縮を維持しない
- 画像が内部で非圧縮形式に展開される

### 現状
- 元PNG: 394KB → PDF: 5.8MB（約15倍）
- 根本解決には `img2pdf` 等の専用ツールが必要

### 将来の改善案
```python
import img2pdf
# img2pdfはPNG/JPEG圧縮をそのまま維持
pdf_bytes = img2pdf.convert(input_file)
```

## 問題4: generate_searchable.js の引数形式

### 原因
- Python スクリプトは `--input-pdf`, `--ocr-json`, `--output-pdf` を期待
- JS は位置引数で渡していた

### 解決策
```javascript
// NG
spawn('python3', [script, pngPath, ocrPath, outputPath])

// OK
spawn('python3', [
  script,
  '--input-pdf', pngPath,
  '--ocr-json', ocrJsonPath,
  '--output-pdf', outputPath
])
```

## 運用ルール

### outputフォルダ
- 処理後は最終確認用の1ファイルのみ残す
- 大量のファイルを残さない

### テスト手順
1. 必ず1ファイルでテスト実行
2. 結果を視覚確認（テキスト選択、透過、サイズ）
3. OKならバッチ処理

## 成功条件チェックリスト

- [ ] テキスト選択時、行単位の自然な矩形
- [ ] ページ全体や列全体が選択されない
- [ ] 視覚的に元PDFと同一（透過テキスト）
- [ ] ファイルサイズが許容範囲内

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `py/searchable_pdf.py` | Searchable PDF生成（行単位text object） |
| `src/generate_searchable.js` | バッチ処理ラッパー |

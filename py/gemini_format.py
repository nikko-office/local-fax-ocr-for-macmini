#!/usr/bin/env python3
"""
Gemini Markdown Formatter

OCR結果のテキストをGemini APIを使ってMarkdown形式に整形する。
FAX文書の構造を認識し、表や見出しを適切にフォーマットする。

Usage:
    python gemini_format.py --ocr-json <json> --output-md <md>

Environment:
    GEMINI_API_KEY: Gemini APIキー (必須)
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import google.generativeai as genai
except ImportError:
    print("Error: google-generativeai is required. Install with: pip install google-generativeai", file=sys.stderr)
    sys.exit(1)


SYSTEM_PROMPT = """あなたはFAX文書のOCR結果を整形するアシスタントです。

与えられたOCRテキストを以下のルールでMarkdown形式に整形してください：

1. **見出し**: 文書タイトル、会社名などは適切な見出し(#, ##)を使用
2. **表形式データ**: 明細、注文リストなどは Markdown テーブルに変換
3. **箇条書き**: 項目リストは箇条書きに
4. **改行の適正化**: OCRノイズによる不要な改行を修正
5. **誤字の軽微な修正**: 明らかなOCR誤認識（例: 0→O, 1→l）は文脈から修正

## 表データの列順序（優先順位）

表を作成する際は、可能な限り以下の列順序を守ってください：

**パターン1（詳細版）:**
工番 → 注文ナンバー → 材質 → 鋼種 → 厚み → 幅 → 長さ → 数量 → 単位 → 摘要 → 備考

**パターン2（簡易版）:**
厚み → 寸法1 → 寸法2 → 数量 → 単位

## 数値と単位の分離

- 「40t×2195φ×390φ」→ 厚み: 40, 寸法1: 2195, 寸法2: 390
- 「6t×38×686 4本」→ 厚み: 6, 幅: 38, 長さ: 686, 数量: 4, 単位: 本

## 注意事項

- 元の情報を損なわないこと
- 推測で情報を追加しないこと
- 日本語の敬称や形式（御中、様など）は保持すること
"""


def load_ocr_document(json_path: str) -> dict:
    """OCR JSONファイルを読み込む"""
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def extract_text(ocr_doc: dict) -> str:
    """OCRドキュメントからテキストを抽出"""
    texts = []
    for page in ocr_doc.get('pages', []):
        for block in page.get('blocks', []):
            block_text = block.get('text', '')
            if block_text:
                texts.append(block_text)
    return '\n\n'.join(texts)


def format_with_gemini(text: str, api_key: str) -> str:
    """Gemini APIでテキストを整形"""
    genai.configure(api_key=api_key)

    model = genai.GenerativeModel(
        model_name='gemini-1.5-flash',
        system_instruction=SYSTEM_PROMPT
    )

    prompt = f"""以下のFAX文書のOCR結果をMarkdown形式に整形してください。

---
{text}
---

上記のテキストを構造化されたMarkdownに変換してください。"""

    response = model.generate_content(prompt)

    return response.text


def main():
    parser = argparse.ArgumentParser(
        description='OCR結果をGeminiでMarkdown整形'
    )
    parser.add_argument(
        '--ocr-json', required=True,
        help='OCR結果JSONファイルパス'
    )
    parser.add_argument(
        '--output-md', required=True,
        help='出力Markdownファイルパス'
    )

    args = parser.parse_args()

    # APIキーの確認
    api_key = os.environ.get('GEMINI_API_KEY')
    if not api_key:
        print("Error: GEMINI_API_KEY environment variable is not set", file=sys.stderr)
        sys.exit(1)

    # 入力ファイルの存在確認
    if not Path(args.ocr_json).exists():
        print(f"Error: OCR JSON not found: {args.ocr_json}", file=sys.stderr)
        sys.exit(1)

    # OCR結果を読み込み
    try:
        ocr_doc = load_ocr_document(args.ocr_json)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    # テキスト抽出
    text = extract_text(ocr_doc)
    if not text.strip():
        print("Warning: No text found in OCR result", file=sys.stderr)
        # 空のMarkdownを作成
        Path(args.output_md).write_text('', encoding='utf-8')
        print(f"Created: {args.output_md} (empty)")
        return

    # Gemini で整形
    try:
        formatted = format_with_gemini(text, api_key)
    except Exception as e:
        print(f"Error: Gemini API failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Markdown を保存
    Path(args.output_md).write_text(formatted, encoding='utf-8')
    print(f"Created: {args.output_md}")


if __name__ == '__main__':
    main()

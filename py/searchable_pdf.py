#!/usr/bin/env python3
"""
Searchable PDF Generator

OCR結果のbbox情報を使って、元のPDFに透明テキストレイヤーを重畳し、
検索可能なPDFを生成する。

Usage:
    python searchable_pdf.py --input-pdf <pdf> --ocr-json <json> --output-pdf <out> [--font-path <font>] [--dpi <dpi>]
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Error: PyMuPDF is required. Install with: pip install PyMuPDF", file=sys.stderr)
    sys.exit(1)


def load_ocr_document(json_path: str) -> dict:
    """OCR JSONファイルを読み込む"""
    with open(json_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def create_searchable_pdf(
    input_pdf: str,
    ocr_doc: dict,
    output_pdf: str,
    font_path: str = None,
    dpi: int = 300
):
    """
    透明テキストレイヤーを重畳したPDFを生成

    Args:
        input_pdf: 入力PDFパス
        ocr_doc: OCR結果のdict (OcrDocument形式)
        output_pdf: 出力PDFパス
        font_path: 日本語フォントパス (省略時はデフォルト)
        dpi: 解像度
    """
    # 入力PDFを開く
    doc = fitz.open(input_pdf)

    # フォントの準備
    if font_path and Path(font_path).exists():
        # カスタムフォントを使用
        fontname = "custom-font"
    else:
        # ビルトインフォント (日本語は文字化けの可能性あり)
        font_path = None
        fontname = "helv"

    # 各ページを処理
    pages = ocr_doc.get('pages', [])

    for page_idx, ocr_page in enumerate(pages):
        if page_idx >= len(doc):
            break

        page = doc[page_idx]
        page_rect = page.rect

        # OCRの座標系とPDFの座標系を変換
        ocr_width = ocr_page.get('width', 1)
        ocr_height = ocr_page.get('height', 1)

        scale_x = page_rect.width / ocr_width
        scale_y = page_rect.height / ocr_height

        # ブロック内の行を処理
        for block in ocr_page.get('blocks', []):
            for line in block.get('lines', []):
                # 行のテキストを取得
                text = line.get('text', '')
                if not text.strip():
                    continue

                # bboxを取得 (x0, y0, x1, y1)
                bbox = line.get('bbox', {})
                x0 = bbox.get('x0', 0) * scale_x
                y0 = bbox.get('y0', 0) * scale_y
                x1 = bbox.get('x1', 0) * scale_x
                y1 = bbox.get('y1', 0) * scale_y

                # フォントサイズを計算 (行の高さに基づく)
                line_height = y1 - y0
                font_size = max(6, min(line_height * 0.8, 72))  # 6pt 〜 72pt

                # 透明テキストを挿入
                rect = fitz.Rect(x0, y0, x1, y1)

                try:
                    if font_path:
                        # カスタムフォント使用
                        page.insert_textbox(
                            rect,
                            text,
                            fontsize=font_size,
                            fontfile=font_path,
                            fontname=fontname,
                            color=(0, 0, 0),  # 黒
                            fill_opacity=0,   # 完全透明
                            render_mode=3,    # 透明 (invisible)
                            align=fitz.TEXT_ALIGN_LEFT
                        )
                    else:
                        # ビルトインフォント (日本語非対応)
                        page.insert_textbox(
                            rect,
                            text,
                            fontsize=font_size,
                            fontname=fontname,
                            color=(0, 0, 0),
                            fill_opacity=0,
                            render_mode=3,
                            align=fitz.TEXT_ALIGN_LEFT
                        )
                except Exception as e:
                    # テキスト挿入に失敗しても続行
                    print(f"Warning: Failed to insert text '{text[:20]}...': {e}", file=sys.stderr)
                    continue

    # 保存
    doc.save(output_pdf, garbage=4, deflate=True)
    doc.close()

    return output_pdf


def main():
    parser = argparse.ArgumentParser(
        description='OCR結果から検索可能なPDFを生成'
    )
    parser.add_argument(
        '--input-pdf', required=True,
        help='入力PDFファイルパス'
    )
    parser.add_argument(
        '--ocr-json', required=True,
        help='OCR結果JSONファイルパス'
    )
    parser.add_argument(
        '--output-pdf', required=True,
        help='出力PDFファイルパス'
    )
    parser.add_argument(
        '--font-path', default=None,
        help='日本語フォントファイルパス (省略時はデフォルトフォント)'
    )
    parser.add_argument(
        '--dpi', type=int, default=300,
        help='解像度 (default: 300)'
    )

    args = parser.parse_args()

    # 入力ファイルの存在確認
    if not Path(args.input_pdf).exists():
        print(f"Error: Input PDF not found: {args.input_pdf}", file=sys.stderr)
        sys.exit(1)

    if not Path(args.ocr_json).exists():
        print(f"Error: OCR JSON not found: {args.ocr_json}", file=sys.stderr)
        sys.exit(1)

    # OCR結果を読み込み
    try:
        ocr_doc = load_ocr_document(args.ocr_json)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    # Searchable PDF 生成
    try:
        output = create_searchable_pdf(
            args.input_pdf,
            ocr_doc,
            args.output_pdf,
            font_path=args.font_path,
            dpi=args.dpi
        )
        print(f"Created: {output}")
    except Exception as e:
        print(f"Error: Failed to create searchable PDF: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()

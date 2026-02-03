#!/usr/bin/env python3
"""
PDF Rotator - Rotate PDF content by specified degrees

コンテンツを実際に回転させる（/Rotate属性ではなく）
"""

import argparse
import sys
from pathlib import Path
import fitz  # PyMuPDF


def rotate_pdf(input_path, output_path, degrees, dpi=150):
    """
    PDFを指定角度で回転（Pixmapを使用して完全に新しいPDFを作成）

    Args:
        input_path: 入力PDFのパス
        output_path: 出力PDFのパス
        degrees: 回転角度（90, 180, 270）時計回り
        dpi: レンダリング解像度
    """
    if degrees not in [90, 180, 270]:
        raise ValueError(f"Invalid rotation: {degrees}. Must be 90, 180, or 270.")

    src_doc = fitz.open(input_path)
    dst_doc = fitz.open()
    page_count = len(src_doc)

    for page_num in range(page_count):
        src_page = src_doc[page_num]

        # ページをPixmapとしてレンダリング（回転を適用）
        mat = fitz.Matrix(dpi / 72, dpi / 72).prerotate(degrees)
        pix = src_page.get_pixmap(matrix=mat)

        # 新しいページを作成（Pixmapのサイズに基づく）
        page_width = pix.width * 72 / dpi
        page_height = pix.height * 72 / dpi
        dst_page = dst_doc.new_page(width=page_width, height=page_height)

        # Pixmapを画像として挿入
        dst_page.insert_image(dst_page.rect, pixmap=pix)

    # ソースを閉じてから保存
    src_doc.close()

    # 保存
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    dst_doc.save(str(output_path), garbage=4, deflate=True)
    dst_doc.close()

    return {
        "rotated": True,
        "degrees": degrees,
        "pages": page_count,
        "output_path": str(output_path)
    }


def main():
    parser = argparse.ArgumentParser(description="Rotate PDF content")
    parser.add_argument("--input-pdf", required=True, help="Input PDF file path")
    parser.add_argument("--output-pdf", required=True, help="Output PDF file path")
    parser.add_argument("--degrees", type=int, required=True, choices=[90, 180, 270],
                        help="Rotation degrees (clockwise: 90, 180, 270)")

    args = parser.parse_args()

    if not Path(args.input_pdf).exists():
        print(f"Error: Input PDF not found: {args.input_pdf}", file=sys.stderr)
        return 1

    try:
        result = rotate_pdf(args.input_pdf, args.output_pdf, args.degrees)
        print(f"✅ PDF rotated {result['degrees']}° clockwise")
        print(f"   Pages: {result['pages']}")
        print(f"   Output: {result['output_path']}")
        return 0
    except Exception as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

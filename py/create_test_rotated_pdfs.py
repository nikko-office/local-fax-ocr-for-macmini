#!/usr/bin/env python3
"""
Create test rotated PDFs from upright PDFs
"""

import argparse
import sys
from pathlib import Path
import fitz

def create_rotated_pdf(input_path, output_path, rotation):
    """
    指定した角度に回転したPDFを作成

    Args:
        input_path: 入力PDF（正立）
        output_path: 出力PDF（回転後）
        rotation: 回転角度（90, 180, 270）
    """
    src = fitz.open(input_path)
    dst = fitz.open()

    for page in src:
        if rotation == 90:
            # 90度回転: 幅と高さを入れ替え
            new_page = dst.new_page(width=page.rect.height, height=page.rect.width)
            new_page.show_pdf_page(new_page.rect, src, page.number, rotate=90)
        elif rotation == 180:
            # 180度回転: サイズそのまま
            new_page = dst.new_page(width=page.rect.width, height=page.rect.height)
            new_page.show_pdf_page(new_page.rect, src, page.number, rotate=180)
        elif rotation == 270:
            # 270度回転: 幅と高さを入れ替え
            new_page = dst.new_page(width=page.rect.height, height=page.rect.width)
            new_page.show_pdf_page(new_page.rect, src, page.number, rotate=270)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    dst.save(str(output_path), garbage=4, deflate=True)
    dst.close()
    src.close()

    print(f"✅ Created {rotation}° rotated PDF: {output_path}")

def main():
    parser = argparse.ArgumentParser(description="Create rotated test PDFs")
    parser.add_argument('--input-pdf', required=True, help="Input PDF (upright)")
    parser.add_argument('--output-dir', required=True, help="Output directory")
    parser.add_argument('--basename', required=True, help="Base name for output files")

    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 90度、180度、270度の回転版を作成
    for rotation in [90, 180, 270]:
        output_path = output_dir / f"{args.basename}_rotated_{rotation}.pdf"
        create_rotated_pdf(args.input_pdf, output_path, rotation)

    print("")
    print("🎉 Test PDFs created successfully!")
    print("")
    print("📄 Next: Test normalize command")
    print(f"   node src/main.js normalize --in {output_dir}/{args.basename}_rotated_90.pdf")

if __name__ == "__main__":
    sys.exit(main())

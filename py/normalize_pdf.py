#!/usr/bin/env python3
"""
PDF Normalizer - Rotate PDFs to portrait orientation (0 degrees)

コンテンツを実際に回転させて視覚とデータを一致させる
"""

import argparse
import sys
from pathlib import Path
import fitz  # PyMuPDF

class PdfNormalizationError(Exception):
    """PDF正規化処理のエラー"""
    pass


def transform_bbox(bbox, rotation, width, height):
    """
    BBoxを回転変換

    Args:
        bbox: {'x0': float, 'y0': float, 'x1': float, 'y1': float}
        rotation: 回転角度（0, 90, 180, 270）
        width: 回転前の幅
        height: 回転前の高さ

    Returns:
        変換後のbbox
    """
    x0, y0, x1, y1 = bbox['x0'], bbox['y0'], bbox['x1'], bbox['y1']

    if rotation == 90:
        # 90度回転: (x, y) -> (y, width - x)
        return {
            'x0': y0,
            'y0': width - x1,
            'x1': y1,
            'y1': width - x0
        }
    elif rotation == 180:
        # 180度回転: (x, y) -> (width - x, height - y)
        return {
            'x0': width - x1,
            'y0': height - y1,
            'x1': width - x0,
            'y1': height - y0
        }
    elif rotation == 270:
        # 270度回転: (x, y) -> (height - y, x)
        return {
            'x0': height - y1,
            'y0': x0,
            'x1': height - y0,
            'y1': x1
        }
    else:
        return bbox


def transform_ocr_coordinates(ocr_data, rotation, page_width, page_height):
    """
    OCR座標を回転に合わせて変換

    Args:
        ocr_data: OCR結果のJSON（OcrDocument形式）
        rotation: 回転角度（0, 90, 180, 270）
        page_width: 回転前のページ幅（ピクセル）
        page_height: 回転前のページ高さ（ピクセル）

    Returns:
        変換後のOCR data
    """
    import copy

    if rotation == 0:
        return ocr_data

    result = copy.deepcopy(ocr_data)

    for page in result.get('pages', []):
        original_width = page.get('width', page_width)
        original_height = page.get('height', page_height)

        # ページサイズを変換
        if rotation == 90 or rotation == 270:
            page['width'], page['height'] = page['height'], page['width']

        # 各ブロックの座標を変換
        for block in page.get('blocks', []):
            # ブロックのbboxを更新
            block_bbox = block.get('bbox')
            if block_bbox:
                block['bbox'] = transform_bbox(
                    block_bbox, rotation, original_width, original_height
                )

            for line in block.get('lines', []):
                # ラインのbboxを更新
                line_bbox = line.get('bbox')
                if line_bbox:
                    line['bbox'] = transform_bbox(
                        line_bbox, rotation, original_width, original_height
                    )

                for token in line.get('tokens', []):
                    bbox = token.get('bbox')
                    if bbox:
                        token['bbox'] = transform_bbox(
                            bbox, rotation, original_width, original_height
                        )

    return result

def needs_normalization(pdf_doc):
    """
    PDFが正規化を必要とするか判定

    Args:
        pdf_doc: PyMuPDF Document

    Returns:
        bool: 正規化が必要な場合True
    """
    for page_num in range(len(pdf_doc)):
        page = pdf_doc[page_num]
        rotation = page.rotation

        if rotation != 0:
            return True

    return False

def normalize_pdf(input_path, output_path=None):
    """
    PDFを正立（0度）に正規化（コンテンツを実際に回転）

    Args:
        input_path: 入力PDFのパス
        output_path: 出力PDFのパス（Noneの場合は上書き）

    Returns:
        dict: 正規化結果
            - normalized: 正規化を実行したか
            - pages: ページ数
            - rotations: 各ページの元の回転角度
    """
    try:
        input_path = Path(input_path)
        if not input_path.exists():
            raise PdfNormalizationError(f"Input PDF not found: {input_path}")

        # PDFを開く
        src_doc = fitz.open(input_path)

        # 正規化が必要か判定
        if not needs_normalization(src_doc):
            page_count = len(src_doc)
            src_doc.close()
            return {
                "normalized": False,
                "pages": page_count,
                "message": "PDF is already normalized (all pages at 0 degrees)"
            }

        # 新しいドキュメントを作成
        dst_doc = fitz.open()
        rotations = []
        normalized_count = 0

        for page_num in range(len(src_doc)):
            src_page = src_doc[page_num]
            rotation = src_page.rotation
            rotations.append(rotation)

            if rotation != 0:
                # 回転に応じてページサイズを決定
                if rotation in [90, 270]:
                    # 90度または270度回転の場合、幅と高さを入れ替え
                    new_width = src_page.rect.height
                    new_height = src_page.rect.width
                else:
                    # 180度回転の場合、サイズはそのまま
                    new_width = src_page.rect.width
                    new_height = src_page.rect.height

                # 新しいページを作成
                dst_page = dst_doc.new_page(width=new_width, height=new_height)

                # コンテンツを挿入（show_pdf_pageは/Rotate属性を自動適用）
                dst_page.show_pdf_page(dst_page.rect, src_doc, page_num)
                normalized_count += 1
            else:
                # 回転不要の場合はそのままコピー
                dst_doc.insert_pdf(src_doc, from_page=page_num, to_page=page_num)

        # 出力先を決定
        if output_path is None:
            output_path = input_path
        else:
            output_path = Path(output_path)
            output_path.parent.mkdir(parents=True, exist_ok=True)

        # 保存
        dst_doc.save(
            str(output_path),
            garbage=4,
            deflate=True
        )
        dst_doc.close()
        src_doc.close()

        return {
            "normalized": True,
            "pages": len(rotations),
            "normalized_pages": normalized_count,
            "rotations": rotations,
            "output_path": str(output_path)
        }

    except Exception as e:
        raise PdfNormalizationError(f"PDF normalization failed: {e}") from e

def main():
    parser = argparse.ArgumentParser(
        description="Normalize PDF rotation to 0 degrees"
    )
    parser.add_argument(
        "--input-pdf",
        required=True,
        help="Input PDF file path"
    )
    parser.add_argument(
        "--output-pdf",
        help="Output PDF file path (default: overwrite input)"
    )

    args = parser.parse_args()

    try:
        result = normalize_pdf(args.input_pdf, args.output_pdf)

        if result["normalized"]:
            print(f"✅ PDF normalized successfully")
            print(f"   Pages: {result['pages']}")
            print(f"   Normalized pages: {result['normalized_pages']}")
            print(f"   Rotations: {result['rotations']}")
            print(f"   Output: {result['output_path']}")
        else:
            print(f"ℹ️  {result['message']}")

        return 0

    except PdfNormalizationError as e:
        print(f"❌ Error: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())

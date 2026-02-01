"""
PaddleOCR wrapper - Converts output to Google Vision API compatible format
"""

import io
import numpy as np
from PIL import Image
from paddleocr import PaddleOCR

from .schemas import (
    FullTextAnnotation,
    Page,
    Block,
    Paragraph,
    Word,
    Symbol,
    BoundingBox,
    Vertex
)


class OCREngine:
    """
    PaddleOCR wrapper class

    Single instance per process (as per proposal requirements)
    """

    def __init__(
        self,
        lang: str = "japan",
        use_gpu: bool = False,
        enable_mkldnn: bool = False
    ):
        """
        Initialize OCR engine

        Args:
            lang: Language setting ("japan" for Japanese)
            use_gpu: GPU usage flag
            enable_mkldnn: MKL-DNN optimization (for Intel CPUs)
        """
        self.ocr = PaddleOCR(
            lang=lang,
            use_gpu=use_gpu,
            enable_mkldnn=enable_mkldnn,
            use_angle_cls=True,  # Rotation detection
            show_log=False
        )

    def recognize(self, image_data: bytes) -> FullTextAnnotation:
        """
        Execute OCR on image and return Google Vision API compatible format

        Args:
            image_data: Image binary data

        Returns:
            FullTextAnnotation: Structured OCR result
        """
        # Load image from binary
        image = Image.open(io.BytesIO(image_data))
        image_np = np.array(image.convert("RGB"))

        # Get image dimensions
        height, width = image_np.shape[:2]

        # Execute PaddleOCR
        result = self.ocr.ocr(image_np, cls=True)

        # Convert result to Google Vision API compatible format
        return self._convert_to_vision_format(result, width, height)

    def _convert_to_vision_format(
        self,
        paddle_result: list,
        width: int,
        height: int
    ) -> FullTextAnnotation:
        """
        Convert PaddleOCR result to Google Vision API fullTextAnnotation format

        PaddleOCR output format:
        [
            [
                [[x1,y1], [x2,y2], [x3,y3], [x4,y4]],  # bbox (4 points)
                (text, confidence)
            ],
            ...
        ]

        Target: Google Vision API fullTextAnnotation format
        """
        blocks = []
        full_text_parts = []

        if paddle_result and paddle_result[0]:
            words = []
            for item in paddle_result[0]:
                if item is None:
                    continue

                bbox_points, (text, confidence) = item

                # Create vertices from 4 points
                vertices = [
                    Vertex(x=int(p[0]), y=int(p[1]))
                    for p in bbox_points
                ]

                # Create symbols (each character)
                symbols = [
                    Symbol(text=char, confidence=float(confidence))
                    for char in text
                ]

                # Create word
                word = Word(
                    boundingBox=BoundingBox(vertices=vertices),
                    symbols=symbols,
                    confidence=float(confidence)
                )
                words.append(word)
                full_text_parts.append(text)

            # Create paragraph from all words
            if words:
                # Calculate overall bounding box
                all_vertices = []
                for w in words:
                    if w.boundingBox:
                        all_vertices.extend(w.boundingBox.vertices)

                paragraph_bbox = None
                if all_vertices:
                    paragraph_bbox = BoundingBox(vertices=[
                        Vertex(x=min(v.x for v in all_vertices), y=min(v.y for v in all_vertices)),
                        Vertex(x=max(v.x for v in all_vertices), y=min(v.y for v in all_vertices)),
                        Vertex(x=max(v.x for v in all_vertices), y=max(v.y for v in all_vertices)),
                        Vertex(x=min(v.x for v in all_vertices), y=max(v.y for v in all_vertices))
                    ])

                paragraph = Paragraph(
                    boundingBox=paragraph_bbox,
                    words=words
                )

                # Create block
                block = Block(
                    boundingBox=paragraph_bbox,
                    paragraphs=[paragraph]
                )
                blocks.append(block)

        # Create page
        page = Page(
            width=width,
            height=height,
            blocks=blocks
        )

        # Full text
        full_text = "\n".join(full_text_parts)

        return FullTextAnnotation(
            text=full_text,
            pages=[page]
        )

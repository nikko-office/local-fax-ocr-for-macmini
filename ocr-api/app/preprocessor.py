"""
FAX image preprocessing pipeline

FAX image characteristics:
- Low resolution (150-200 DPI)
- High noise
- Low contrast
"""

import io
import cv2
import numpy as np
from PIL import Image


class ImagePreprocessor:
    """
    FAX image preprocessor

    Processing steps:
    1. Scale up (resolution enhancement)
    2. Grayscale conversion
    3. Binarization (Otsu's method)
    4. Noise removal
    """

    def __init__(
        self,
        scale_factor: float = 2.0,
        binarize: bool = True,
        binarize_threshold: int = 0,  # 0 = Otsu auto
        denoise: bool = True
    ):
        self.scale_factor = scale_factor
        self.binarize = binarize
        self.binarize_threshold = binarize_threshold
        self.denoise = denoise

    def process(self, image_data: bytes) -> bytes:
        """
        Execute image preprocessing

        Args:
            image_data: Input image binary

        Returns:
            bytes: Processed image binary
        """
        # Load image from binary
        image = Image.open(io.BytesIO(image_data))
        img_np = np.array(image.convert("RGB"))

        # Convert to BGR for OpenCV
        img_bgr = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)

        # 1. Scale up
        if self.scale_factor != 1.0:
            img_bgr = self._scale(img_bgr)

        # 2. Convert to grayscale
        img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

        # 3. Noise removal
        if self.denoise:
            img_gray = self._denoise(img_gray)

        # 4. Binarization
        if self.binarize:
            img_gray = self._binarize(img_gray)

        # Convert back to RGB for PaddleOCR input
        img_rgb = cv2.cvtColor(img_gray, cv2.COLOR_GRAY2RGB)

        # Convert to binary
        pil_image = Image.fromarray(img_rgb)
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG")

        return buffer.getvalue()

    def _scale(self, img: np.ndarray) -> np.ndarray:
        """Scale up image"""
        new_width = int(img.shape[1] * self.scale_factor)
        new_height = int(img.shape[0] * self.scale_factor)

        return cv2.resize(
            img,
            (new_width, new_height),
            interpolation=cv2.INTER_CUBIC
        )

    def _denoise(self, img: np.ndarray) -> np.ndarray:
        """Remove noise using Non-local Means Denoising"""
        return cv2.fastNlMeansDenoising(img, None, 10, 7, 21)

    def _binarize(self, img: np.ndarray) -> np.ndarray:
        """Binarization"""
        if self.binarize_threshold == 0:
            # Otsu's method for automatic threshold
            _, binary = cv2.threshold(
                img, 0, 255,
                cv2.THRESH_BINARY + cv2.THRESH_OTSU
            )
        else:
            # Fixed threshold
            _, binary = cv2.threshold(
                img, self.binarize_threshold, 255,
                cv2.THRESH_BINARY
            )

        return binary

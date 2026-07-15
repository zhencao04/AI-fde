from rapidocr_onnxruntime import RapidOCR
from PIL import Image, ImageDraw
import numpy as np
import os

# 生成一张简单的中文 + 英文测试图
im = Image.new("RGB", (600, 200), (255, 255, 255))
d = ImageDraw.Draw(im)
d.text((20, 20), "Customer info", fill=(0, 0, 0))
d.text((20, 60), "Order number: SO202506190001", fill=(0, 0, 0))
d.text((20, 100), "Email: test@example.com", fill=(0, 0, 0))
d.text((20, 140), "Phone: 13800138000", fill=(0, 0, 0))

out_path = os.path.join(os.path.dirname(__file__), "..", ".data", "test-ocr2.png")
os.makedirs(os.path.dirname(out_path), exist_ok=True)
im.save(out_path)
print("Saved:", out_path)

ocr = RapidOCR()
result, _ = ocr(out_path)
print("OCR result:")
for line in result or []:
    print(" ", line)

"""
本地离线 OCR HTTP 服务（基于 RapidOCR / PaddleOCR-ONNX）。

功能：
    POST /ocr              —— 单张图片 OCR
        body (multipart/form-data): file=<binary>  或  summaryHint=<text>
        body (application/json):
            {"imageBase64": "<base64...>"}  或
            {"imagePath": "<absolute local path>"}  或
            {"precomputedText": "<text>"}   # 直接回传文本（由 Node 侧兜底）
        返回: {
            "status": "ok",
            "text": "line1\nline2\n...",
            "lines": [{"text": "...", "confidence": 0.95, "bbox": [[x,y],...]}],
            "durationMs": 123,
            "mode": "ocr|precomputed|mock"
        }

    POST /ocr/batch         —— 批量 OCR（供视频分析使用）
        body: {"frames": [{"index": 0, "imageBase64": "..."}|{"path": "..."} , ...]}

    GET  /health            —— liveness / readiness
        返回: {"status": "ok", "model": "RapidOCR-ONNX", "provider": "local-paddle"}

设计原则：
    * 零框架依赖：仅使用标准库 http.server
    * 懒加载：首次 /ocr 请求时才初始化 ONNX 模型（~2 秒）
    * 大图自动压缩：短边 > 960 像素时按比例缩小，保证速度
    * 错误降级：OCR 失败时不崩溃，返回空文本 + 原因
"""

import base64
import json
import os
import sys
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from io import BytesIO
from pathlib import Path
from socketserver import ThreadingMixIn

try:
    import numpy as np
except ImportError:
    print("[ocr-server] numpy not installed —— please run: pip install -r requirements.txt",
          file=sys.stderr)
    raise

try:
    import cv2
except ImportError:
    cv2 = None  # 延迟报错，让服务先起来

# ------------------------------------------------------------
# RapidOCR 初始化（懒加载）
# ------------------------------------------------------------
_OCR_INSTANCE = None
_INIT_ERROR = None


def _get_ocr():
    global _OCR_INSTANCE, _INIT_ERROR
    if _OCR_INSTANCE is not None:
        return _OCR_INSTANCE
    if _INIT_ERROR is not None:
        raise RuntimeError(_INIT_ERROR)
    try:
        from rapidocr_onnxruntime import RapidOCR
        t0 = time.time()
        _OCR_INSTANCE = RapidOCR()
        print(f"[ocr-server] RapidOCR initialized in {time.time() - t0:.2f}s", flush=True)
        return _OCR_INSTANCE
    except Exception as e:
        _INIT_ERROR = f"{type(e).__name__}: {e}"
        print(f"[ocr-server] RapidOCR init failed: {_INIT_ERROR}", file=sys.stderr, flush=True)
        raise


# ------------------------------------------------------------
# 图像解码与压缩
# ------------------------------------------------------------
def _decode_image_bytes(raw: bytes):
    """把 bytes 转成 OpenCV ndarray；优先 Pillow，失败退回 numpy。"""
    try:
        from PIL import Image
        with Image.open(BytesIO(raw)) as im:
            im = im.convert("RGB")
            arr = np.array(im)
            # 转成 BGR 供 OpenCV 处理
            return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR) if cv2 is not None else arr
    except Exception:
        # fallback: 直接 numpy 解码
        if cv2 is None:
            raise
        arr = np.frombuffer(raw, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def _maybe_resize(img, max_short_edge: int = 960):
    if cv2 is None or img is None:
        return img
    h, w = img.shape[:2]
    short = min(h, w)
    if short <= max_short_edge:
        return img
    ratio = max_short_edge / short
    new_w = int(round(w * ratio))
    new_h = int(round(h * ratio))
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _ocr_bytes(raw: bytes):
    img = _decode_image_bytes(raw)
    if img is None:
        return None, "IMAGE_DECODE_FAILED"
    img = _maybe_resize(img)
    ocr = _get_ocr()
    # result: list of [box, text, score]  或  None
    result, _ = ocr(img)
    if not result:
        return [], None
    lines = []
    for item in result:
        # RapidOCR 格式：[bbox(list[4][2]), text(str), score(float)]
        bbox = item[0] if len(item) >= 1 else []
        text = item[1] if len(item) >= 2 else ""
        score = item[2] if len(item) >= 3 else 0.0
        try:
            bbox_json = [[int(float(x)), int(float(y))] for x, y in bbox]
        except Exception:
            bbox_json = []
        lines.append({"text": text, "confidence": float(score), "bbox": bbox_json})
    return lines, None


def _ocr_file(path: str):
    if not os.path.isfile(path):
        return None, "FILE_NOT_FOUND"
    with open(path, "rb") as f:
        return _ocr_bytes(f.read())


# ------------------------------------------------------------
# HTTP Handler
# ------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    # 减少默认 request/response 日志噪音，但保留 error log
    def log_message(self, format, *args):
        # 注释掉可关闭；保留一份轻量日志
        sys.stderr.write(f"[ocr-server] {self.address_string()} - {format % args}\n")

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _parse_multipart(self, body: bytes):
        content_type = self.headers.get("Content-Type", "")
        boundary_token = None
        for part in content_type.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary_token = part.split("=", 1)[1].strip().strip('"')
        if not boundary_token:
            return {}, b""
        boundary = b"--" + boundary_token.encode("utf-8")
        sections = body.split(boundary)
        fields = {}
        file_bytes = b""
        for sec in sections:
            if not sec or sec.startswith(b"--") or sec in (b"\r\n", b""):
                continue
            header_end = sec.find(b"\r\n\r\n")
            if header_end == -1:
                continue
            header_block = sec[:header_end].decode("utf-8", errors="replace")
            content = sec[header_end + 4:]
            if content.endswith(b"\r\n"):
                content = content[:-2]
            name_token = None
            filename_token = None
            for line in header_block.split("\r\n"):
                if line.lower().startswith("content-disposition:"):
                    for piece in line.split(";"):
                        piece = piece.strip()
                        if piece.startswith("name="):
                            name_token = piece.split("=", 1)[1].strip('"')
                        elif piece.startswith("filename="):
                            filename_token = piece.split("=", 1)[1].strip('"')
            if filename_token and not file_bytes:
                file_bytes = content
            elif name_token:
                try:
                    fields[name_token] = content.decode("utf-8")
                except Exception:
                    fields[name_token] = ""
        return fields, file_bytes

    # ---------- Routing ----------
    def do_GET(self):
        if self.path.startswith("/health") or self.path.startswith("/"):
            try:
                # /health 返回 ready 状态
                try:
                    _get_ocr()
                    ready = True
                    reason = "ok"
                except Exception as e:
                    ready = False
                    reason = str(e)
                self._send_json(200, {
                    "status": "ok" if ready else "not_ready",
                    "model": "RapidOCR-ONNX",
                    "provider": "local-paddle",
                    "python": sys.version.split()[0],
                    "ready": ready,
                    "reason": reason,
                })
            except Exception as e:
                self._send_json(500, {"status": "error", "error": str(e)})
            return
        self._send_json(404, {"status": "error", "error": "NOT_FOUND"})

    def do_POST(self):
        body = self._read_body()
        try:
            if self.path.startswith("/ocr/batch"):
                return self._handle_batch(body)
            if self.path.startswith("/ocr"):
                content_type = self.headers.get("Content-Type", "")
                if "multipart/form-data" in content_type:
                    return self._handle_multipart(body)
                # JSON body
                return self._handle_json(body)
            self._send_json(404, {"status": "error", "error": "NOT_FOUND"})
        except Exception as e:
            print(f"[ocr-server] request error: {e}", file=sys.stderr, flush=True)
            self._send_json(500, {"status": "error", "error": str(e)})

    # ---------- Handlers ----------
    def _handle_multipart(self, body: bytes):
        t0 = time.time()
        fields, file_bytes = self._parse_multipart(body)
        if file_bytes:
            lines, err = _ocr_bytes(file_bytes)
            mode = "ocr"
        elif "imageBase64" in fields and fields["imageBase64"]:
            clean = fields["imageBase64"].split(",", 1)[-1]  # strip data:image/...;base64,
            raw = base64.b64decode(clean)
            lines, err = _ocr_bytes(raw)
            mode = "ocr"
        elif "precomputedText" in fields and fields["precomputedText"]:
            text = fields["precomputedText"]
            lines = [{"text": line, "confidence": 1.0, "bbox": []}
                     for line in text.splitlines() if line.strip()]
            err = None
            mode = "precomputed"
        else:
            lines, err = [], None
            mode = "mock"

        merged_text = "\n".join(ln["text"] for ln in lines) if lines else ""
        self._send_json(200, {
            "status": "ok" if err is None else "partial",
            "text": merged_text,
            "lines": lines,
            "error": err,
            "mode": mode,
            "durationMs": int((time.time() - t0) * 1000),
        })

    def _handle_json(self, body: bytes):
        t0 = time.time()
        if not body:
            self._send_json(400, {"status": "error", "error": "EMPTY_BODY"})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._send_json(400, {"status": "error", "error": "INVALID_JSON"})
            return

        if "precomputedText" in payload and payload["precomputedText"]:
            text = str(payload["precomputedText"])
            lines = [{"text": line, "confidence": 1.0, "bbox": []}
                     for line in text.splitlines() if line.strip()]
            merged_text = text
            mode = "precomputed"
        elif "imageBase64" in payload and payload["imageBase64"]:
            clean = str(payload["imageBase64"]).split(",", 1)[-1]
            raw = base64.b64decode(clean)
            lines, err = _ocr_bytes(raw)
            merged_text = "\n".join(ln["text"] for ln in lines) if lines else ""
            mode = "ocr"
        elif "imagePath" in payload and payload["imagePath"]:
            lines, err = _ocr_file(str(payload["imagePath"]))
            merged_text = "\n".join(ln["text"] for ln in lines) if lines else ""
            mode = "ocr"
        else:
            merged_text, lines, err = "", [], None
            mode = "mock"

        self._send_json(200, {
            "status": "ok",
            "text": merged_text,
            "lines": lines,
            "error": None if isinstance(lines, list) else (lines if isinstance(lines, str) else None),
            "mode": mode,
            "durationMs": int((time.time() - t0) * 1000),
        })

    def _handle_batch(self, body: bytes):
        t0 = time.time()
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            self._send_json(400, {"status": "error", "error": "INVALID_JSON"})
            return
        frames = payload.get("frames", []) or []
        results = []
        for idx, frame in enumerate(frames):
            start = time.time()
            try:
                if frame.get("precomputedText"):
                    lines = [{"text": line, "confidence": 1.0, "bbox": []}
                             for line in str(frame["precomputedText"]).splitlines() if line.strip()]
                    mode = "precomputed"
                elif frame.get("imageBase64"):
                    clean = str(frame["imageBase64"]).split(",", 1)[-1]
                    raw = base64.b64decode(clean)
                    lines, err = _ocr_bytes(raw)
                    mode = "ocr"
                elif frame.get("path"):
                    lines, err = _ocr_file(str(frame["path"]))
                    mode = "ocr"
                else:
                    lines, err, mode = [], None, "mock"
                merged = "\n".join(ln["text"] for ln in lines) if lines else ""
                results.append({
                    "index": frame.get("index", idx),
                    "text": merged,
                    "lines": lines,
                    "mode": mode,
                    "durationMs": int((time.time() - start) * 1000),
                })
            except Exception as e:
                results.append({"index": frame.get("index", idx), "text": "",
                                "lines": [], "mode": "error",
                                "error": str(e), "durationMs": int((time.time() - start) * 1000)})
        self._send_json(200, {
            "status": "ok",
            "results": results,
            "totalFrames": len(results),
            "durationMs": int((time.time() - t0) * 1000),
        })


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """每请求开一个线程处理，避免批量 OCR 时阻塞。"""
    daemon_threads = True
    allow_reuse_address = True


def main():
    host = os.environ.get("OCR_HOST", "127.0.0.1")
    port = int(os.environ.get("OCR_PORT", "9003"))
    print(f"[ocr-server] starting on http://{host}:{port} (PID {os.getpid()})", flush=True)
    print(f"[ocr-server] provider: local-paddle / RapidOCR-ONNX", flush=True)
    try:
        server = ThreadedHTTPServer((host, port), Handler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ocr-server] shutting down", flush=True)
        server.server_close()


if __name__ == "__main__":
    main()

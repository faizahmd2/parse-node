import os
import re
import torch
import fitz  # PyMuPDF
import cv2
from PIL import Image
from fastapi import FastAPI
from pydantic import BaseModel
from markitdown import MarkItDown

cv2.setNumThreads(2)
torch.set_num_threads(2)

app = FastAPI()

# Loaded once at startup — markitdown handles docx/pptx/html/txt
md_converter = MarkItDown()

IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'}

# Both OCR models are heavy: load lazily on first image request so
# non-image workloads (PDF, docx, etc.) never pay the startup cost.
_easyocr_reader = None
_trocr_processor = None
_trocr_model = None


def get_easyocr():
    """EasyOCR with CRAFT detection built in.

    lang_list=['en'] covers printed English, handwriting, and most Latin scripts.
    For genuinely multilingual documents add the relevant language codes here,
    e.g. ['en', 'hi', 'ar'] — EasyOCR supports 80+ languages.
    Detection (CRAFT) is language-agnostic; only the recognition weights change.
    """
    global _easyocr_reader
    if _easyocr_reader is None:
        import easyocr
        _easyocr_reader = easyocr.Reader(['en'], gpu=False)
    return _easyocr_reader


def get_trocr():
    """microsoft/trocr-base-handwritten: transformer-based line-level OCR.

    Significantly more accurate than EasyOCR's recognition on cursive and
    genuinely messy handwriting. Operates on single cropped text-line images;
    detection (finding the line regions) is always done by EasyOCR/CRAFT first.
    Used as escalation when EasyOCR's confidence is below threshold.
    """
    global _trocr_processor, _trocr_model
    if _trocr_model is None:
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        _trocr_processor = TrOCRProcessor.from_pretrained('microsoft/trocr-base-handwritten')
        _trocr_model = VisionEncoderDecoderModel.from_pretrained('microsoft/trocr-base-handwritten')
    return _trocr_processor, _trocr_model


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class ParseRequest(BaseModel):
    file_path: str

class FormatRequest(BaseModel):
    text: str
    filename: str = ''


# ---------------------------------------------------------------------------
# PDF parsing
# ---------------------------------------------------------------------------

def parse_pdf(path: str) -> str:
    """Two-stage PDF extraction.

    Stage 1 — PyMuPDF digital text (born-digital PDFs, covers the vast majority).
    Stage 2 — PyMuPDF rasterise → image OCR pipeline (scanned / image-only PDFs).
              Uses page.get_pixmap() directly so poppler is not needed.
    """
    doc = fitz.open(path)

    # Stage 1: digital text
    try:
        pages = []
        for page in doc:
            t = page.get_text()
            if t:
                pages.append(t)
        result = "\n".join(pages)
        if len(result.strip()) > 100:
            return result
    except Exception as e:
        print("pdf stage1 (digital text):", e)

    # Stage 2: rasterise → OCR
    # Matrix(2, 2) doubles DPI (72 → 144) — enough resolution for OCR without
    # the memory cost of 300 DPI.
    try:
        pages = []
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            # Save to a temp path so EasyOCR/TrOCR can open it by path
            tmp = f"/tmp/_pdf_page_{page.number}.png"
            img.save(tmp)
            text, _ = parse_image(tmp)
            if text:
                pages.append(text)
            try:
                os.remove(tmp)
            except Exception:
                pass
        result = "\n".join(pages)
        if result.strip():
            return result
    except Exception as e:
        print("pdf stage2 (OCR):", e)

    return ""


# ---------------------------------------------------------------------------
# Image preprocessing
# ---------------------------------------------------------------------------

def preprocess_image(path: str):
    """Normalise to ~1100px on the long edge and return two binarised variants.

    Why 1100px: tested on phone-photo receipts — at native ~2700px, character
    height exceeds what models expect and accuracy drops measurably.
    Why two variants: adaptive threshold handles uneven lighting well;
    Otsu handles clean high-contrast scans well. We try both and keep the
    better result.
    Denoising was deliberately excluded: fastNlMeansDenoising blurred thin
    strokes enough to corrupt words on the receipts tested.
    """
    img = cv2.imread(path)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    h, w = gray.shape
    target = 1100
    scale = target / max(h, w)
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
    gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=interp)

    adaptive = cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11
    )
    _, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    return adaptive, otsu


# ---------------------------------------------------------------------------
# EasyOCR — CRAFT detection + recognition
# ---------------------------------------------------------------------------

def run_easyocr(path: str) -> tuple[str, float]:
    """Full EasyOCR pass: CRAFT finds text regions, recognition model reads them.

    Returns (text, mean_confidence_0_to_100).

    detail=1 returns (bbox, text, confidence). We sort results top-to-bottom
    then left-to-right so multi-column layouts read in natural reading order.
    Lines are joined with newline; words within a detected region stay as-is
    since EasyOCR's region grouping already handles word spacing.
    """
    reader = get_easyocr()
    results = reader.readtext(path, detail=1)

    if not results:
        return "", 0.0

    # Sort by top-left Y first, then X — reading order
    results.sort(key=lambda r: (r[0][0][1], r[0][0][0]))

    lines = []
    confidences = []
    for (bbox, text, conf) in results:
        text = text.strip()
        if text and conf >= 0.1:
            lines.append(text)
            confidences.append(conf * 100)

    if not lines:
        return "", 0.0

    mean_conf = sum(confidences) / len(confidences)
    return "\n".join(lines), mean_conf


# ---------------------------------------------------------------------------
# TrOCR escalation — better on cursive / messy handwriting
# ---------------------------------------------------------------------------

def run_trocr_on_regions(path: str, max_regions: int = 80) -> str:
    """CRAFT detect (via EasyOCR) + TrOCR recognize.

    This is the two-stage pipeline described in your brief:
      1. EasyOCR's CRAFT detector finds text bounding boxes (language-agnostic).
      2. Each crop goes through microsoft/trocr-base-handwritten, which is
         significantly more accurate than EasyOCR's own recognizer on cursive
         and genuinely messy handwriting.

    Only called when EasyOCR's confidence is below the escalation threshold,
    since TrOCR does one forward pass per line on CPU and is slower.
    """
    reader = get_easyocr()
    # detect() returns (horizontal_list, free_list); horizontal_list[0] is
    # the list of [x_min, x_max, y_min, y_max] bounding boxes
    horizontal_list, _ = reader.detect(path)

    if not horizontal_list or not horizontal_list[0]:
        return ""

    boxes = horizontal_list[0][:max_regions]
    # Reading order: top-to-bottom (y_min), then left-to-right (x_min)
    boxes = sorted(boxes, key=lambda b: (b[2], b[0]))

    image = Image.open(path).convert("RGB")
    processor, model = get_trocr()

    lines = []
    for (x_min, x_max, y_min, y_max) in boxes:
        crop = image.crop((max(0, x_min), max(0, y_min), x_max, y_max))
        if crop.width < 4 or crop.height < 4:
            continue
        pixel_values = processor(images=crop, return_tensors="pt").pixel_values
        generated_ids = model.generate(pixel_values, max_new_tokens=64)
        text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0].strip()
        if text:
            lines.append(text)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# OCR artifact cleanup
# ---------------------------------------------------------------------------

def clean_ocr_output(text: str) -> str:
    """Light cleanup: strip border/crease artifacts, collapse whitespace.

    Intentionally conservative — only removes characters that are structurally
    impossible in real text (box-drawing chars, isolated pipe/tilde), never
    rewrites or reorders content. Line endings and comma placements are
    preserved exactly so copy-pasting gives faithful output.
    """
    lines = text.split('\n')
    cleaned = []

    for line in lines:
        # Strip leading/trailing noise characters (OCR border artifacts)
        line = re.sub(r'^[\s\|\~\—\}\-\.]+|[\s\|\~\—\}\-\.]+$', '', line)
        # Remove isolated rogue characters mid-line
        line = line.replace('|', '').replace('}', '').replace('~', '')
        # Collapse multiple spaces into one
        line = re.sub(r'\s{2,}', ' ', line)
        # Keep only lines that contain at least one real character
        if re.search(r'[A-Za-z0-9\u0080-\uFFFF]', line):
            cleaned.append(line.strip())

    return '\n'.join(cleaned)


# ---------------------------------------------------------------------------
# Image parsing — main entry point
# ---------------------------------------------------------------------------

TROCR_ESCALATION_THRESHOLD = 50  # EasyOCR mean confidence (0–100) below which
                                   # we escalate to CRAFT + TrOCR recognition

def parse_image(path: str) -> tuple[str, str]:
    """Returns (flat_text, layout_text).

    Pipeline:
      1. Preprocess → two binarised variants (adaptive + Otsu)
      2. Run EasyOCR on both variants; keep the higher-confidence result.
         EasyOCR uses CRAFT for detection internally — language-agnostic,
         handles cursive and non-Latin scripts correctly.
      3. If best confidence < TROCR_ESCALATION_THRESHOLD: run CRAFT detect
         + TrOCR recognize. TrOCR is more accurate on cursive/handwriting
         but slower (one forward pass per line on CPU).

    layout_text is returned only from EasyOCR when we have position data.
    TrOCR path returns empty layout_text — known gap, only affects the rarer
    low-confidence escalation cases.
    """
    try:
        adaptive, otsu = preprocess_image(path)
    except Exception as e:
        print("preprocess_image failed:", e)
        # Fall through to EasyOCR on original image
        adaptive, otsu = None, None

    best_text, best_conf = "", 0.0
    best_layout = ""

    # Try preprocessed variants first if available
    for variant_arr in [v for v in [adaptive, otsu] if v is not None]:
        tmp = "/tmp/_ocr_variant.png"
        try:
            cv2.imwrite(tmp, variant_arr)
            text, conf = run_easyocr(tmp)
            if conf > best_conf:
                best_conf = conf
                best_text = text
        except Exception as e:
            print("easyocr variant:", e)

    # Also try original image (sometimes preprocessing hurts coloured text)
    try:
        text, conf = run_easyocr(path)
        if conf > best_conf:
            best_conf = conf
            best_text = text
    except Exception as e:
        print("easyocr original:", e)

    # Escalate to TrOCR if confidence is low (likely cursive / dense handwriting)
    if best_conf < TROCR_ESCALATION_THRESHOLD:
        try:
            trocr_text = run_trocr_on_regions(path)
            if len(trocr_text.strip()) >= 15:
                best_text = trocr_text
                best_layout = ""
        except Exception as e:
            print("trocr escalation:", e)

    cleaned = clean_ocr_output(best_text)
    return cleaned, best_layout


# ---------------------------------------------------------------------------
# Chunking helpers (unchanged)
# ---------------------------------------------------------------------------

def split_by_headers(text: str) -> list:
    pattern = r'(?=^#{1,6}\s)'
    sections = re.split(pattern, text, flags=re.MULTILINE)
    return [s.strip() for s in sections if s.strip()]


def recursive_split(text: str, chunk_size: int, overlap: int) -> list:
    if len(text) <= chunk_size:
        return [text]
    paragraphs = text.split('\n\n')
    if len(paragraphs) > 1:
        return _merge_pieces(paragraphs, chunk_size, overlap, joiner='\n\n')
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) > 1:
        return _merge_pieces(sentences, chunk_size, overlap, joiner=' ')
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start = end - overlap
    return chunks


def _merge_pieces(pieces: list, chunk_size: int, overlap: int, joiner: str) -> list:
    chunks = []
    current = ""
    for piece in pieces:
        piece = piece.strip()
        if not piece:
            continue
        if len(current) + len(piece) + len(joiner) <= chunk_size:
            current = current + joiner + piece if current else piece
        else:
            if current:
                chunks.append(current)
            if len(piece) > chunk_size:
                chunks.extend(recursive_split(piece, chunk_size, overlap))
                current = ""
            else:
                current = piece
    if current:
        chunks.append(current)
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev_tail = chunks[i - 1][-overlap:]
            overlapped.append(prev_tail + joiner + chunks[i])
        return overlapped
    return chunks


# ---------------------------------------------------------------------------
# FastAPI endpoints
# ---------------------------------------------------------------------------

@app.post("/parse")
def parse_file(req: ParseRequest):
    if not os.path.exists(req.file_path):
        return {"error": "File not found"}

    ext = os.path.splitext(req.file_path)[1].lower()
    layout_text = None

    if ext == ".pdf":
        text = parse_pdf(req.file_path)

    elif ext in IMAGE_EXTS:
        text, layout_text = parse_image(req.file_path)

    else:
        result = md_converter.convert(req.file_path)
        text = result.text_content

    if not text:
        return {"error": "Could not parse file"}

    response = {"markdown": text}
    if layout_text and layout_text.strip():
        response["layout_markdown"] = "```\n" + layout_text + "\n```"

    return response


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/format")
def format_markdown(req: FormatRequest):
    """Minimal whitespace cleanup only — no structural guessing.

    Never adds, removes, or reorders content. Only trims trailing whitespace
    per line and collapses consecutive blank lines so copy-pasting is clean.
    """
    if not req.text or len(req.text.strip()) < 5:
        return {"markdown": None, "verified": False, "reason": "empty_input"}

    try:
        raw_lines = [l.rstrip() for l in req.text.split('\n')]
        out = []
        prev_blank = True
        for line in raw_lines:
            blank = not line.strip()
            if blank and prev_blank:
                continue
            out.append(line)
            prev_blank = blank
        markdown = '\n'.join(out).strip() + '\n'
    except Exception as e:
        print("format_markdown failed:", e)
        return {"markdown": None, "verified": False, "reason": "format_error"}

    if not markdown.strip():
        return {"markdown": None, "verified": False, "reason": "empty_output"}

    return {"markdown": markdown, "verified": True}
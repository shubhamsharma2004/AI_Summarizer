from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from openai import AsyncOpenAI
from dotenv import load_dotenv
import os, json, pathlib, hashlib, uuid
from datetime import datetime, timezone

load_dotenv()

app = FastAPI(title="AI Document Analyzer")

PROVIDER = os.getenv("PROVIDER", "openai").lower()
RATE_LIMIT = int(os.getenv("RATE_LIMIT_PER_HOUR", "20"))

# ── Upstash Redis ────────────────────────────────────────────
redis = None
if os.getenv("UPSTASH_REDIS_REST_URL") and os.getenv("UPSTASH_REDIS_REST_TOKEN"):
    from upstash_redis.asyncio import Redis as UpstashRedis
    redis = UpstashRedis(
        url=os.getenv("UPSTASH_REDIS_REST_URL"),
        token=os.getenv("UPSTASH_REDIS_REST_TOKEN"),
    )

# ── Provider clients ─────────────────────────────────────────
_openai_client = None
_groq_client = None
_anthropic_client = None

if PROVIDER == "openai" and os.getenv("OPENAI_API_KEY"):
    _openai_client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

elif PROVIDER == "groq" and os.getenv("GROQ_API_KEY"):
    _groq_client = AsyncOpenAI(
        api_key=os.getenv("GROQ_API_KEY"),
        base_url="https://api.groq.com/openai/v1",
    )

elif PROVIDER == "anthropic" and os.getenv("ANTHROPIC_API_KEY"):
    from anthropic import AsyncAnthropic
    _anthropic_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

PROVIDER_INFO = {
    "openai":    {"label": "GPT-4o Mini",          "model": "gpt-4o-mini"},
    "groq":      {"label": "Groq · Llama 3.3 70B", "model": "llama-3.3-70b-versatile"},
    "anthropic": {"label": "Claude Haiku 3.5",      "model": "claude-haiku-4-5-20251001"},
}

SYSTEM_PROMPT = """You are a highly skilled document analyst.

Respond ONLY with a valid JSON object (no markdown, no code fences) using this exact structure:
{
  "overview": "2-3 line overview of the document",
  "keyPoints": ["point 1", "point 2", "..."],
  "insights": ["insight 1", "insight 2", "..."],
  "criticalData": ["data point 1", "..."],
  "conclusion": "Final takeaway paragraph"
}

Instructions:
1. overview: Short overview (2-3 lines)
2. keyPoints: 4-6 key points in bullet format
3. insights: Important insights, conclusions, or takeaways
4. criticalData: Critical numbers, stats, or trends (empty array if none)
5. conclusion: Concise and accurate final takeaway
6. Avoid repetition or irrelevant details"""


# ── Redis helpers ────────────────────────────────────────────

def doc_hash(text: str) -> str:
    return hashlib.sha256(text[:15000].encode()).hexdigest()


async def check_rate_limit(request: Request):
    if not redis:
        return
    ip = request.client.host or "unknown"
    key = f"ratelimit:{ip}"
    count = await redis.incr(key)
    if count == 1:
        await redis.expire(key, 3600)
    if count > RATE_LIMIT:
        raise HTTPException(
            429,
            f"Rate limit exceeded — max {RATE_LIMIT} requests/hour. Try again later."
        )


async def get_cached(text_hash: str):
    if not redis:
        return None
    val = await redis.get(f"cache:{text_hash}")
    if val is None:
        return None
    return json.loads(val) if isinstance(val, str) else val


async def set_cached(text_hash: str, result: dict):
    if not redis:
        return
    await redis.set(f"cache:{text_hash}", json.dumps(result), ex=86400)  # 24h TTL


async def push_history(source: str, result: dict, cached: bool = False):
    if not redis:
        return
    entry = {
        "id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "overview": (result.get("overview") or "")[:150],
        "provider": PROVIDER_INFO.get(PROVIDER, {}).get("label", PROVIDER),
        "cached": cached,
        "result": result,
    }
    await redis.lpush("history", json.dumps(entry))
    await redis.ltrim("history", 0, 49)  # keep last 50


# ── AI call ──────────────────────────────────────────────────

async def call_ai(text: str) -> dict:
    truncated = text[:15000]

    if PROVIDER == "groq" and _groq_client:
        completion = await _groq_client.chat.completions.create(
            model=PROVIDER_INFO["groq"]["model"],
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Analyze this document:\n\n{truncated}"},
            ],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
        return json.loads(completion.choices[0].message.content)

    elif PROVIDER == "anthropic" and _anthropic_client:
        msg = await _anthropic_client.messages.create(
            model=PROVIDER_INFO["anthropic"]["model"],
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Analyze this document:\n\n{truncated}"}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw)

    elif PROVIDER == "openai" and _openai_client:
        completion = await _openai_client.chat.completions.create(
            model=PROVIDER_INFO["openai"]["model"],
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Analyze this document:\n\n{truncated}"},
            ],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
        return json.loads(completion.choices[0].message.content)

    else:
        raise RuntimeError(
            f"Provider '{PROVIDER}' is not configured. "
            "Check your .env file (OPENAI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY)."
        )


async def call_ai_raw(prompt: str) -> dict:
    """Call the AI with a free-form prompt expecting a JSON response."""
    if PROVIDER == "groq" and _groq_client:
        completion = await _groq_client.chat.completions.create(
            model=PROVIDER_INFO["groq"]["model"],
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        return json.loads(completion.choices[0].message.content)

    elif PROVIDER == "anthropic" and _anthropic_client:
        msg = await _anthropic_client.messages.create(
            model=PROVIDER_INFO["anthropic"]["model"],
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
        return json.loads(raw)

    elif PROVIDER == "openai" and _openai_client:
        completion = await _openai_client.chat.completions.create(
            model=PROVIDER_INFO["openai"]["model"],
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        return json.loads(completion.choices[0].message.content)

    else:
        raise RuntimeError(f"Provider '{PROVIDER}' is not configured.")


def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    ext = pathlib.Path(filename).suffix.lower()
    if ext == ".pdf":
        import fitz
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        return "\n".join(page.get_text() for page in doc)
    elif ext == ".docx":
        from docx import Document
        import io
        doc = Document(io.BytesIO(file_bytes))
        return "\n".join(p.text for p in doc.paragraphs)
    elif ext in (".txt", ".md", ".csv"):
        return file_bytes.decode("utf-8", errors="ignore")
    else:
        raise ValueError(f"Unsupported file type: {ext}. Use PDF, DOCX, TXT, MD, or CSV.")


# ── API Routes ───────────────────────────────────────────────

class TextRequest(BaseModel):
    text: str

class TranslateRequest(BaseModel):
    result: dict


@app.get("/api/provider")
async def get_provider():
    info = PROVIDER_INFO.get(PROVIDER, {"label": PROVIDER, "model": "unknown"})
    return {
        "provider": PROVIDER,
        "label": info["label"],
        "model": info["model"],
        "redis": redis is not None,
    }


@app.post("/api/analyze")
async def analyze_text(req: TextRequest, request: Request):
    if len(req.text.strip()) < 20:
        raise HTTPException(400, "Please provide valid document text (at least 20 characters).")

    await check_rate_limit(request)

    h = doc_hash(req.text)
    cached_result = await get_cached(h)
    if cached_result:
        await push_history("Pasted text", cached_result, cached=True)
        return {"success": True, "result": cached_result, "cached": True}

    try:
        result = await call_ai(req.text)
        await set_cached(h, result)
        await push_history("Pasted text", result, cached=False)
        return {"success": True, "result": result, "cached": False}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/analyze-file")
async def analyze_file(request: Request, file: UploadFile = File(...)):
    await check_rate_limit(request)

    file_bytes = await file.read()
    if len(file_bytes) > 10 * 1024 * 1024:
        raise HTTPException(400, "File too large. Maximum size is 10MB.")
    try:
        text = extract_text_from_file(file_bytes, file.filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not text.strip():
        raise HTTPException(400, "Could not extract text from the file.")

    h = doc_hash(text)
    cached_result = await get_cached(h)
    if cached_result:
        await push_history(file.filename, cached_result, cached=True)
        return {"success": True, "result": cached_result, "cached": True, "fileName": file.filename}

    try:
        result = await call_ai(text)
        await set_cached(h, result)
        await push_history(file.filename, result, cached=False)
        return {"success": True, "result": result, "cached": False, "fileName": file.filename}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/api/translate")
async def translate_to_hindi(req: TranslateRequest, request: Request):
    await check_rate_limit(request)

    prompt = f"""Translate the following document analysis JSON into Hindi.
Keep the exact same JSON structure and keys. Only translate the text values — do NOT translate the JSON keys.
Respond ONLY with the valid JSON object, no markdown, no code fences.

{json.dumps(req.result, ensure_ascii=False)}"""

    try:
        result = await call_ai_raw(prompt)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.get("/api/history")
async def get_history():
    if not redis:
        return {"items": [], "redis": False}
    raw = await redis.lrange("history", 0, 49)
    items = [json.loads(r) if isinstance(r, str) else r for r in raw]
    return {"items": items, "redis": True}


@app.delete("/api/history")
async def clear_history():
    if not redis:
        raise HTTPException(503, "Redis not configured.")
    await redis.delete("history")
    return {"success": True}


# ── Serve Frontend ───────────────────────────────────────────
app.mount("/", StaticFiles(directory="public", html=True), name="static")

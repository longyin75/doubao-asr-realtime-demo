import os
import sys
import logging
import base64
import time
from typing import List, Optional, Dict
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import speaker_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("voiceprint-service")

SPEAKER_DB: Dict[str, np.ndarray] = {}
MIN_ENROLL_AUDIO_SEC = float(os.environ.get("VP_MIN_ENROLL_SEC", "1.5"))
MIN_VERIFY_AUDIO_SEC = float(os.environ.get("VP_MIN_VERIFY_SEC", "1.0"))
MATCH_THRESHOLD = float(os.environ.get("VP_MATCH_THRESHOLD", "0.28"))


class EnrollRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)
    audio_base64: str
    audio_format: str = Field("wav", pattern="^(wav|pcm)$")


class VerifyRequest(BaseModel):
    audio_base64: str
    audio_format: str = Field("wav", pattern="^(wav|pcm)$")
    top_n: int = Field(3, ge=1, le=20)
    threshold: Optional[float] = None


class SpeakerInfo(BaseModel):
    username: str
    score: float
    cosine_similarity: float


class EnrollResponse(BaseModel):
    success: bool
    username: str
    audio_duration_sec: float


class VerifyResponse(BaseModel):
    success: bool
    results: List[SpeakerInfo]
    total_registered: int
    audio_duration_sec: float
    model_type: str


class StatusResponse(BaseModel):
    status: str
    model_type: str
    device: str
    registered_count: int
    match_threshold: float


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("=" * 50)
    logger.info("Starting Open Source Voiceprint Service...")
    logger.info(f"Match threshold (cosine): {MATCH_THRESHOLD}")
    logger.info("Preloading model (first run may download ~100MB)...")
    try:
        speaker_model.load_model()
        logger.info(f"Model ready on device: {speaker_model._device}")
    except Exception as e:
        logger.error(f"Model load failed: {e}")
    logger.info("=" * 50)
    yield
    logger.info("Shutting down")


app = FastAPI(title="Open Source Voiceprint Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _decode_audio_base64(b64: str) -> bytes:
    try:
        return base64.b64decode(b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64: {e}")


def _estimate_duration_sec(audio_bytes: bytes, fmt: str) -> float:
    if fmt == "pcm":
        return len(audio_bytes) / 2.0 / speaker_model.SAMPLE_RATE
    else:
        import soundfile as sf
        import io
        try:
            info = sf.info(io.BytesIO(audio_bytes))
            return float(info.frames) / info.samplerate
        except:
            return len(audio_bytes) / 32000.0


@app.get("/healthz", response_model=StatusResponse)
async def healthz():
    model_ready = speaker_model._speaker_model is not None
    return StatusResponse(
        status="ready" if model_ready else "loading",
        model_type=speaker_model._model_type,
        device=speaker_model._device,
        registered_count=len(SPEAKER_DB),
        match_threshold=MATCH_THRESHOLD,
    )


@app.get("/api/v1/speakers")
async def list_speakers():
    return {"speakers": list(SPEAKER_DB.keys()), "count": len(SPEAKER_DB)}


@app.post("/api/v1/enroll", response_model=EnrollResponse)
async def enroll(req: EnrollRequest):
    audio_bytes = _decode_audio_base64(req.audio_base64)
    dur = _estimate_duration_sec(audio_bytes, req.audio_format)

    if dur < MIN_ENROLL_AUDIO_SEC:
        raise HTTPException(
            status_code=400,
            detail=f"Audio too short ({dur:.2f}s), minimum {MIN_ENROLL_AUDIO_SEC}s",
        )

    logger.info(f"Enrolling speaker '{req.username}' ({dur:.2f}s audio)")

    try:
        t0 = time.time()
        emb = speaker_model.extract_embedding(audio_bytes, req.audio_format)
        SPEAKER_DB[req.username] = emb
        elapsed = (time.time() - t0) * 1000
        logger.info(f"Enrolled '{req.username}' in {elapsed:.0f}ms, total speakers: {len(SPEAKER_DB)}")
        return EnrollResponse(success=True, username=req.username, audio_duration_sec=dur)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.exception("Enroll failed")
        raise HTTPException(status_code=500, detail=f"Enroll failed: {e}")


@app.post("/api/v1/verify", response_model=VerifyResponse)
async def verify(req: VerifyRequest):
    if len(SPEAKER_DB) == 0:
        raise HTTPException(status_code=404, detail="No speakers registered")

    audio_bytes = _decode_audio_base64(req.audio_base64)
    dur = _estimate_duration_sec(audio_bytes, req.audio_format)

    if dur < MIN_VERIFY_AUDIO_SEC:
        raise HTTPException(
            status_code=400,
            detail=f"Audio too short ({dur:.2f}s), minimum {MIN_VERIFY_AUDIO_SEC}s",
        )

    threshold = req.threshold if req.threshold is not None else MATCH_THRESHOLD

    try:
        t0 = time.time()
        emb = speaker_model.extract_embedding(audio_bytes, req.audio_format)
        elapsed_model = (time.time() - t0) * 1000

        results: List[SpeakerInfo] = []
        for username, spk_emb in SPEAKER_DB.items():
            cos_sim = speaker_model.cosine_similarity(emb, spk_emb)
            score = speaker_model.score_to_confidence(cos_sim, threshold)
            results.append(
                SpeakerInfo(
                    username=username,
                    score=round(score, 2),
                    cosine_similarity=round(cos_sim, 4),
                )
            )

        results.sort(key=lambda x: x.cosine_similarity, reverse=True)
        results = results[: req.top_n]

        total_elapsed = (time.time() - t0) * 1000
        top_match = results[0] if results else None
        logger.info(
            f"Verify: {len(SPEAKER_DB)} speakers, top='{top_match.username if top_match else None}' "
            f"cos={top_match.cosine_similarity if top_match else 0:.3f} "
            f"score={top_match.score if top_match else 0:.1f} "
            f"model={elapsed_model:.0f}ms total={total_elapsed:.0f}ms"
        )

        return VerifyResponse(
            success=True,
            results=results,
            total_registered=len(SPEAKER_DB),
            audio_duration_sec=dur,
            model_type=speaker_model._model_type,
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        logger.exception("Verify failed")
        raise HTTPException(status_code=500, detail=f"Verify failed: {e}")


@app.delete("/api/v1/speakers/{username}")
async def delete_speaker(username: str):
    if username not in SPEAKER_DB:
        raise HTTPException(status_code=404, detail=f"Speaker '{username}' not found")
    del SPEAKER_DB[username]
    logger.info(f"Deleted speaker '{username}', remaining: {len(SPEAKER_DB)}")
    return {"success": True, "username": username, "remaining": len(SPEAKER_DB)}


@app.delete("/api/v1/speakers")
async def delete_all_speakers():
    count = len(SPEAKER_DB)
    SPEAKER_DB.clear()
    logger.info(f"Deleted all {count} speakers")
    return {"success": True, "deleted": count}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("VP_PORT", "8001"))
    host = os.environ.get("VP_HOST", "0.0.0.0")
    uvicorn.run("app:app", host=host, port=port, log_level="info")

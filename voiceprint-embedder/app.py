import base64
import time
import logging
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import numpy as np

import speaker_model

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("vp-embedder")

app = FastAPI(title="Voiceprint Embedder Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class EmbedRequest(BaseModel):
    audio_b64: str = Field(..., description="Base64 encoded audio data")
    format: str = Field("wav", description="Audio format: wav or pcm (16kHz mono S16LE)")


class EmbedBatchRequest(BaseModel):
    audios: list[EmbedRequest]


class EmbedResponse(BaseModel):
    embedding: list[float]
    duration_ms: int
    model: str
    device: str


class HealthResponse(BaseModel):
    status: str
    model: str
    model_id: str
    device: str
    cuda_available: bool
    gpu_name: str
    cuda_version: Optional[str]
    embedding_dim: int
    sample_rate: int


@app.on_event("startup")
async def startup_event():
    logger.info("Pre-loading CAM++ model on startup...")
    speaker_model.load_model()
    info = speaker_model.get_device_info()
    logger.info(f"Model ready on {info['device']}: {info['gpu_name'] or 'CPU'}")


@app.get("/healthz", response_model=HealthResponse)
async def healthz():
    try:
        info = speaker_model.get_device_info()
        return HealthResponse(status="ok", **info)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Model not loaded: {str(e)}")


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    t0 = time.time()
    try:
        audio_bytes = base64.b64decode(req.audio_b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64: {str(e)}")

    if len(audio_bytes) < 100:
        raise HTTPException(status_code=400, detail="Audio data too short")

    try:
        emb, duration_ms = speaker_model.extract_embedding(audio_bytes, req.format)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception(f"Embedding extraction failed: {e}")
        raise HTTPException(status_code=500, detail=f"Embedding failed: {str(e)}")

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info(f"Embedding extracted: duration={duration_ms}ms, inference={elapsed_ms}ms")

    return EmbedResponse(
        embedding=emb.tolist(),
        duration_ms=duration_ms,
        model=speaker_model._model_type,
        device=speaker_model._device,
    )


@app.post("/embed-batch")
async def embed_batch(req: EmbedBatchRequest):
    if len(req.audios) > 100:
        raise HTTPException(status_code=400, detail="Batch size limit is 100")

    results = []
    t0 = time.time()
    for i, item in enumerate(req.audios):
        try:
            audio_bytes = base64.b64decode(item.audio_b64)
            emb, duration_ms = speaker_model.extract_embedding(audio_bytes, item.format)
            results.append({
                "index": i,
                "embedding": emb.tolist(),
                "duration_ms": duration_ms,
                "ok": True,
            })
        except Exception as e:
            results.append({"index": i, "ok": False, "error": str(e)})

    elapsed_ms = int((time.time() - t0) * 1000)
    logger.info(f"Batch embedding: {len(results)} items in {elapsed_ms}ms")
    return {"results": results, "total_ms": elapsed_ms}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002, log_level="info")

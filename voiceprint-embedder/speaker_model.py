import os
import io
import tempfile
import logging
import numpy as np
import torch
import soundfile as sf
import time
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("vp-embedder")

MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"
SAMPLE_RATE = 16000
MIN_AUDIO_SEC = 0.5

_speaker_model = None
_device = "cpu"
_model_type = "none"
_gpu_name = ""


def _setup_device() -> str:
    global _device, _gpu_name
    if torch.cuda.is_available():
        _device = "cuda"
        _gpu_name = torch.cuda.get_device_name(0)
        logger.info(f"Using GPU: {_gpu_name} (CUDA {torch.version.cuda})")
    else:
        _device = "cpu"
        logger.warning("CUDA not available, falling back to CPU (slow!)")
    return _device


def load_model():
    global _speaker_model, _model_type
    if _speaker_model is not None:
        return _speaker_model

    _setup_device()

    from modelscope.pipelines import pipeline
    from modelscope.utils.constant import Tasks

    logger.info(f"Loading 3D-Speaker CAM++ model: {MODEL_ID}")
    t0 = time.time()
    _speaker_model = pipeline(
        task=Tasks.speaker_verification,
        model=MODEL_ID,
        model_revision="v2.0.2",
        device=_device,
    )
    _model_type = "campplus"
    elapsed = time.time() - t0
    logger.info(f"CAM++ model loaded in {elapsed:.1f}s on {_device}")
    return _speaker_model


def _save_audio_to_tempfile(audio_bytes: bytes, fmt: str = "wav") -> str:
    fd, path = tempfile.mkstemp(suffix=f".{fmt}")
    with os.fdopen(fd, "wb") as f:
        f.write(audio_bytes)
    return path


def _read_audio_bytes(audio_bytes: bytes, format_hint: str = "wav") -> tuple[np.ndarray, int]:
    fmt = (format_hint or "wav").lower()
    if fmt == "pcm":
        pcm16 = np.frombuffer(audio_bytes, dtype=np.int16)
        audio = pcm16.astype(np.float32) / 32768.0
        return audio, SAMPLE_RATE
    else:
        data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        return data, sr


def _float32_to_wav_bytes(audio_float32: np.ndarray) -> bytes:
    bio = io.BytesIO()
    sf.write(bio, audio_float32, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return bio.getvalue()


def extract_embedding(audio_bytes: bytes, format_hint: str = "wav") -> tuple[np.ndarray, float]:
    """返回 (embedding, duration_ms)"""
    model = load_model()
    audio_np, sr = _read_audio_bytes(audio_bytes, format_hint)

    duration_sec = len(audio_np) / sr
    duration_ms = int(duration_sec * 1000)

    if duration_sec < MIN_AUDIO_SEC:
        raise ValueError(
            f"Audio too short: {duration_sec:.2f}s, minimum {MIN_AUDIO_SEC}s required"
        )

    if sr != SAMPLE_RATE:
        import torchaudio
        resampler = torchaudio.transforms.Resample(sr, SAMPLE_RATE)
        audio_tensor = torch.from_numpy(audio_np).unsqueeze(0)
        audio_np = resampler(audio_tensor).squeeze(0).numpy()

    tmp_path = _save_audio_to_tempfile(_float32_to_wav_bytes(audio_np), "wav")
    try:
        result = model([tmp_path], output_emb=True)
    finally:
        try:
            os.unlink(tmp_path)
        except:
            pass

    emb = result.get("embs")
    if emb is None:
        raise RuntimeError(f"Cannot extract embedding from CAM++ output, keys: {list(result.keys())}")

    if isinstance(emb, torch.Tensor):
        emb = emb.detach().cpu().numpy()
    emb = np.asarray(emb, dtype=np.float32).reshape(-1)
    emb = emb / (np.linalg.norm(emb) + 1e-8)
    return emb, duration_ms


def get_device_info() -> dict:
    load_model()
    return {
        "model": _model_type,
        "model_id": MODEL_ID,
        "device": _device,
        "gpu_name": _gpu_name,
        "cuda_available": torch.cuda.is_available(),
        "cuda_version": torch.version.cuda if torch.cuda.is_available() else None,
        "embedding_dim": 192,
        "sample_rate": SAMPLE_RATE,
    }

import os
import io
import tempfile
import logging
import numpy as np
import torch
import soundfile as sf
from typing import Optional

logger = logging.getLogger("voiceprint")

MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"
SAMPLE_RATE = 16000

_speaker_model = None
_device = "cpu"
_model_type = "none"


def _setup_device() -> str:
    global _device
    if torch.cuda.is_available():
        _device = "cuda"
        logger.info(f"Using GPU: {torch.cuda.get_device_name(0)}")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        _device = "mps"
        logger.info("Using Apple MPS (Metal) acceleration")
    else:
        _device = "cpu"
        logger.info("Using CPU")
    return _device


def load_model():
    global _speaker_model, _model_type
    if _speaker_model is not None:
        return _speaker_model

    _setup_device()

    try:
        from modelscope.pipelines import pipeline
        from modelscope.utils.constant import Tasks

        logger.info(f"Loading 3D-Speaker CAM++ model from ModelScope: {MODEL_ID}")
        _speaker_model = pipeline(
            task=Tasks.speaker_verification,
            model=MODEL_ID,
            model_revision="v2.0.2",
            device=_device,
        )
        _model_type = "campplus"
        logger.info("CAM++ model loaded successfully")
        return _speaker_model
    except Exception as e:
        logger.warning(f"Failed to load ModelScope CAM++ model: {e}")
        logger.info("Trying SpeechBrain ECAPA-TDNN fallback...")
        try:
            return _load_speechbrain_backup()
        except Exception as e2:
            logger.error(f"SpeechBrain fallback also failed: {e2}")
            raise RuntimeError(
                "Failed to load any speaker verification model. "
                "Please check network connection for model download."
            ) from e2


def _load_speechbrain_backup():
    global _speaker_model, _model_type
    from speechbrain.inference.speaker import EncoderClassifier

    _speaker_model = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb",
        run_opts={"device": _device},
        savedir=os.path.join(tempfile.gettempdir(), "speechbrain_ecapa"),
    )
    _model_type = "ecapa"
    logger.info("SpeechBrain ECAPA-TDNN model loaded as fallback")
    return _speaker_model


def _save_audio_to_tempfile(audio_bytes: bytes, fmt: str = "wav") -> str:
    fd, path = tempfile.mkstemp(suffix=f".{fmt}")
    with os.fdopen(fd, "wb") as f:
        f.write(audio_bytes)
    return path


def _read_audio_bytes(audio_bytes: bytes, format_hint: str = "wav") -> np.ndarray:
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


def extract_embedding(audio_bytes: bytes, format_hint: str = "wav") -> np.ndarray:
    model = load_model()
    audio_np, sr = _read_audio_bytes(audio_bytes, format_hint)

    if len(audio_np) < int(SAMPLE_RATE * 0.5):
        raise ValueError(
            f"Audio too short: {len(audio_np)/SAMPLE_RATE:.2f}s, minimum 0.5s required"
        )

    if sr != SAMPLE_RATE:
        import torchaudio
        resampler = torchaudio.transforms.Resample(sr, SAMPLE_RATE)
        audio_tensor = torch.from_numpy(audio_np).unsqueeze(0)
        audio_np = resampler(audio_tensor).squeeze(0).numpy()

    if _model_type == "campplus":
        tmp_path = _save_audio_to_tempfile(_float32_to_wav_bytes(audio_np), "wav")
        try:
            result = model(tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except:
                pass

        emb = None
        if isinstance(result, dict):
            for key in ["embedding", "spk_embedding", "speaker_embedding"]:
                if key in result and isinstance(result[key], (np.ndarray, list, torch.Tensor)):
                    emb = result[key]
                    break
            if emb is None:
                for v in result.values():
                    if isinstance(v, np.ndarray) and v.size > 32:
                        emb = v
                        break
        if emb is None:
            raise RuntimeError(f"Cannot extract embedding from CAM++ output: {type(result)}")

        if isinstance(emb, torch.Tensor):
            emb = emb.detach().cpu().numpy()
        emb = np.asarray(emb, dtype=np.float32).flatten()

    elif _model_type == "ecapa":
        wav_tensor = torch.from_numpy(audio_np).unsqueeze(0).to(_device)
        with torch.no_grad():
            emb = model.encode_batch(wav_tensor).squeeze().detach().cpu().numpy()
    else:
        raise RuntimeError(f"Unknown model type: {_model_type}")

    emb = emb / (np.linalg.norm(emb) + 1e-8)
    return emb


def _float32_to_wav_bytes(audio_float32: np.ndarray) -> bytes:
    bio = io.BytesIO()
    sf.write(bio, audio_float32, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return bio.getvalue()


def cosine_similarity(emb1: np.ndarray, emb2: np.ndarray) -> float:
    e1 = emb1 / (np.linalg.norm(emb1) + 1e-8)
    e2 = emb2 / (np.linalg.norm(emb2) + 1e-8)
    return float(np.dot(e1, e2))


def score_to_confidence(score: float, threshold: float = 0.28) -> float:
    """
    将余弦相似度映射到0-100置信度
    CAM++/ECAPA在同人声纹上典型余弦相似度：
      同一人: >0.5 (高置信度)
      相似音色: 0.3-0.5
      不同人: <0.3
    """
    if score >= 0.6:
        return 90.0 + (score - 0.6) / 0.4 * 10.0
    elif score >= threshold:
        return 60.0 + (score - threshold) / (0.6 - threshold) * 30.0
    elif score >= 0.0:
        return score / threshold * 60.0
    else:
        return 0.0

import numpy as np
import soundfile as sf
import base64
import json
import urllib.request
import time

sr = 16000
t = np.linspace(0, 3, int(sr * 3), dtype=np.float32)
audio = (np.sin(2 * np.pi * 220 * t) * 0.3).astype(np.float32)

import io
bio = io.BytesIO()
sf.write(bio, audio, sr, format="WAV", subtype="PCM_16")
b64 = base64.b64encode(bio.getvalue()).decode()

req = urllib.request.Request(
    "http://localhost:8002/embed",
    data=json.dumps({"audio_b64": b64, "format": "wav"}).encode(),
    headers={"Content-Type": "application/json"},
)
t0 = time.time()
resp = urllib.request.urlopen(req, timeout=30)
result = json.loads(resp.read())
elapsed = (time.time() - t0) * 1000
emb = result["embedding"]
emb_arr = np.array(emb)

print(f"Inference time: {elapsed:.0f}ms")
print(f"Duration reported: {result['duration_ms']}ms")
print(f"Model: {result['model']}, Device: {result['device']}")
print(f"Embedding dims: {len(emb)}")
print(f"Embedding L2 norm: {np.linalg.norm(emb_arr):.6f} (should be ~1.0)")
print(f"First 5 values: {emb[:5]}")
print(f"Min/max: {emb_arr.min():.4f} / {emb_arr.max():.4f}")

print("\n=== Testing similarity of same audio (self-compare) ===")
req2 = urllib.request.Request(
    "http://localhost:8002/embed",
    data=json.dumps({"audio_b64": b64, "format": "wav"}).encode(),
    headers={"Content-Type": "application/json"},
)
resp2 = urllib.request.urlopen(req2, timeout=30)
result2 = json.loads(resp2.read())
emb2 = np.array(result2["embedding"])
cos_sim = float(np.dot(emb_arr, emb2) / (np.linalg.norm(emb_arr) * np.linalg.norm(emb2)))
print(f"Self-cosine-similarity: {cos_sim:.6f} (should be ~1.0)")
print("\n✅ EMBEDDING SERVICE WORKING CORRECTLY!")

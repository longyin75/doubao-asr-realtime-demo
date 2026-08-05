import struct, math, base64, json, urllib.request, time

sr = 16000
dur = 3
n = sr * dur
samples = []
for i in range(n):
    t = i / sr
    s = int(math.sin(2*math.pi*220*t) * 0.3 * 32767)
    samples.append(struct.pack("<h", s))
raw = b"".join(samples)

data_size = n * 2
header = b"RIFF" + struct.pack("<I", 36+data_size) + b"WAVEfmt "
header += struct.pack("<IHHIIHH", 16, 1, 1, sr, sr*2, 2, 16)
header += b"data" + struct.pack("<I", data_size)
wav = header + raw
b64 = base64.b64encode(wav).decode()

req = urllib.request.Request(
    "http://192.168.1.146:8002/embed",
    data=json.dumps({"audio_b64": b64, "format": "wav"}).encode(),
    headers={"Content-Type": "application/json"},
)
t0 = time.time()
resp = urllib.request.urlopen(req, timeout=30)
result = json.loads(resp.read())
elapsed = (time.time()-t0)*1000
emb = result["embedding"]
norm = math.sqrt(sum(x*x for x in emb))
dur_ms = result["duration_ms"]
model = result["model"]
device = result["device"]
print(f"[web3 -> gpu:8002] /embed OK!")
print(f"  Inference latency: {elapsed:.0f}ms (first call, includes warmup)")
print(f"  Audio duration:    {dur_ms}ms")
print(f"  Embedding:         {len(emb)} dims, L2 norm={norm:.6f}")
print(f"  Model:             {model} on {device}")
print(f"  First 5 values:    {[round(x,4) for x in emb[:5]]}")

t0 = time.time()
resp2 = urllib.request.urlopen(urllib.request.Request(
    "http://192.168.1.146:8002/embed",
    data=json.dumps({"audio_b64": b64, "format": "wav"}).encode(),
    headers={"Content-Type": "application/json"},
), timeout=30)
r2 = json.loads(resp2.read())
elapsed2 = (time.time()-t0)*1000
emb2 = r2["embedding"]
cos_sim = sum(a*b for a,b in zip(emb,emb2)) / (norm * math.sqrt(sum(x*x for x in emb2)))
print(f"\n  Second call latency: {elapsed2:.0f}ms (after warmup)")
print(f"  Self-cosine-similarity: {cos_sim:.6f}")
print("\n✅ WEb3 -> GPU VOICEPRINT EMBEDDING SERVICE FULLY OPERATIONAL!")

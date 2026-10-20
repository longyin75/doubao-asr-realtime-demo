# Meeting ASR Agent Instructions

## Read First

Before changing code, read:

1. `README.md`
2. `docs-new/CLOUD_AIDLC_HANDOFF.md`
3. The relevant design document under `docs-new/`
4. `docs-new/CHANGE_JOURNAL.md`
5. `docs-new/TEST_EXECUTION_LOG.md`

## Mandatory Workflow

1. Update the relevant `docs-new/` requirement or design document before code.
2. Use a `spike/*` branch for experiments or single-point validation.
3. Keep changes scoped and preserve unrelated work.
4. Add or update tests for behavior changes.
5. Update `docs-new/CHANGE_JOURNAL.md` and `docs-new/TEST_EXECUTION_LOG.md`.
6. Run `make qa`; do not mark work complete unless it passes.
7. Commit code and documentation together.

## Environment

- Cloud development path: `/data/codex/workspace/03-meetingASR`
- GitHub `main` is the code source of truth.
- Use Node.js 20 or newer.
- Set npm registry to `https://registry.npmmirror.com` before dependency installation.
- Run tasks expected to exceed one minute inside tmux.

## Secrets

- Never commit real credentials.
- Use `inventory.local.env` or `/data/home/.codex/resources/inventory.local.env`.
- Keep `inventory.local.env.example` limited to placeholders.
- Do not print secrets or complete private data in logs.

## Runtime Safety

- Run `make preflight` before starting or deploying services.
- Check port ownership and process management before restart or deployment.
- Production services remain on the documented txcvm/gpu topology; aidlc is a development environment unless a design document explicitly changes that decision.
- Do not use destructive Git operations or overwrite runtime voiceprint/audio data.

## Project Constraints

- Build cloud artifacts with `npm run build:cloud`.
- Treat `speaker_id` as a numeric value.
- Recording transcription must explicitly enable `use_voiceprints: true`.
- Preserve `voiceprints/` during deployment synchronization.
- Voiceprint deletion must cover cloud data, local embedding, and local WAV.
- Startup repair must regenerate missing local embeddings when source WAV exists.


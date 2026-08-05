.PHONY: install dev build start qa clean vp-install vp-start vp-dev vp-status \
        dev-cloud build-cloud start-cloud preflight \
        cloud-setup cloud-build cloud-sync cloud-deps cloud-deploy cloud-status cloud-logs cloud-restart cloud-stop

NPM = npm
NPM_CONFIG_REGISTRY = https://registry.npmmirror.com
CLOUD_PORT ?= 3001
CLOUD_IP ?= 212.64.57.180
CLOUD_PUBLIC_DOMAIN ?= longer8888.tech
CLOUD_PUBLIC_PATH ?= /asr-demo-multi
SSH_TARGET ?= shcvm
REMOTE_DIR ?= /root/doubao-asr-cloud

install:
	NPM_CONFIG_REGISTRY=$(NPM_CONFIG_REGISTRY) $(NPM) install

dev:
	$(NPM) run dev

build:
	$(NPM) run build

start:
	node dist/server/index.js

dev-cloud:
	$(NPM) run dev:cloud

build-cloud:
	$(NPM) run build:cloud

start-cloud:
	cd dist && CLOUD_PORT=$(CLOUD_PORT) node server-cloud/index.js

preflight:
	@echo "=== Preflight check ==="
	@if lsof -i :$(CLOUD_PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "ERROR: Port $(CLOUD_PORT) is already in use:"; \
		lsof -i :$(CLOUD_PORT) -sTCP:LISTEN; \
		exit 1; \
	fi
	@echo "Port $(CLOUD_PORT) is free"
	@test -f inventory.local.env || (echo "WARNING: inventory.local.env not found" && exit 0)
	@echo "Preflight OK"

vp-install:
	cd voiceprint-service && bash -c "if [ ! -d venv ]; then python3 -m venv venv; fi && source venv/bin/activate && pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip && pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt"

vp-start:
	cd voiceprint-service && bash start.sh

vp-dev:
	cd voiceprint-service && source venv/bin/activate && VP_PORT=8001 python app.py

vp-status:
	@curl -s http://127.0.0.1:8001/healthz || echo "voiceprint-service not running"

qa:
	@echo "=== Running QA checks ==="
	@echo "1. TypeScript type check..."
	npx tsc --noEmit
	@echo "2. JavaScript syntax check (local)..."
	node -e "new Function(require('fs').readFileSync('public/app.js','utf8'))"
	@echo "3. JavaScript syntax check (cloud)..."
	node -e "new Function(require('fs').readFileSync('public-cloud/app.js','utf8'))"
	@echo "4. HTML file exists (local)..."
	@test -f public/index.html || (echo "ERROR: public/index.html missing" && exit 1)
	@echo "5. HTML file exists (cloud)..."
	@test -f public-cloud/index.html || (echo "ERROR: public-cloud/index.html missing" && exit 1)
	@echo "6. CSS file exists (local)..."
	@test -f public/style.css || (echo "ERROR: public/style.css missing" && exit 1)
	@echo "7. CSS file exists (cloud)..."
	@test -f public-cloud/style.css || (echo "ERROR: public-cloud/style.css missing" && exit 1)
	@echo "8. Server config check (local)..."
	@test -f server/config.ts || (echo "ERROR: server/config.ts missing" && exit 1)
	@echo "9. Server config check (cloud)..."
	@test -f server-cloud/config.ts || (echo "ERROR: server-cloud/config.ts missing" && exit 1)
	@echo "10. Protocol codec check (local)..."
	@test -f server/asr-protocol.ts || (echo "ERROR: server/asr-protocol.ts missing" && exit 1)
	@echo "11. Protocol codec check (cloud)..."
	@test -f server-cloud/asr-protocol.ts || (echo "ERROR: server-cloud/asr-protocol.ts missing" && exit 1)
	@echo "12. MP3 encoder module check..."
	@test -f server-cloud/mp3-encoder.ts || (echo "ERROR: server-cloud/mp3-encoder.ts missing" && exit 1)
	@echo "13. Cloud entry point check..."
	@test -f server-cloud/index.ts || (echo "ERROR: server-cloud/index.ts missing" && exit 1)
	@echo "14. Cloud server root routes check..."
	@grep -q "urlPath === '/'" server-cloud/index.ts || (echo "ERROR: root route missing in cloud server" && exit 1)
	@grep -q "recording_ready" server-cloud/index.ts || (echo "ERROR: recording_ready message missing in cloud server" && exit 1)
	@echo "15. Voiceprint service files check..."
	@test -f voiceprint-service/app.py || (echo "ERROR: voiceprint-service/app.py missing" && exit 1)
	@test -f voiceprint-service/requirements.txt || (echo "ERROR: voiceprint-service/requirements.txt missing" && exit 1)
	@echo "16. Frontend recording player check..."
	@grep -q "recordingPlayerContainer" public-cloud/app.js || (echo "ERROR: recordingPlayerContainer missing in cloud frontend" && exit 1)
	@grep -q "recording_ready" public-cloud/app.js || (echo "ERROR: recording_ready handler missing in cloud frontend" && exit 1)
	@echo "17. Frontend basePath support check..."
	@grep -q "getBasePath" public-cloud/app.js || (echo "ERROR: getBasePath missing in cloud frontend" && exit 1)
	@echo "18. No hardcoded secrets in cloud server..."
	@! grep -rn "Tcdn@2025" server-cloud/ public-cloud/ deploy/ --include="*.ts" --include="*.js" --include="*.html" --include="*.json" --include="*.sh" --include="*.cjs" 2>/dev/null || (echo "ERROR: Server password found in code!" && exit 1)
	@echo "19. Deploy ecosystem config exists..."
	@test -f deploy/ecosystem.config.cjs || (echo "ERROR: deploy/ecosystem.config.cjs missing" && exit 1)
	@echo "20. Remote setup script exists..."
	@test -f deploy/setup-remote.sh || (echo "ERROR: deploy/setup-remote.sh missing" && exit 1)
	@echo "21. Security check (mediaDevices / secure context)..."
	@grep -q "mediaDevices" public-cloud/app.js || (echo "ERROR: mediaDevices check missing in cloud frontend" && exit 1)
	@echo "22. Hotword support check..."
	@grep -q "hotwords\|corpus" server-cloud/asr-config.ts || (echo "ERROR: corpus/hotwords missing in asr-config.ts" && exit 1)
	@grep -q "correct_words" server-cloud/asr-config.ts || (echo "ERROR: correct_words missing in asr-config.ts" && exit 1)
	@grep -q "boosting_table_id" server-cloud/asr-config.ts || (echo "ERROR: boosting_table_id missing in asr-config.ts" && exit 1)
	@grep -q "parseHotwordsInput\|hotwordsInput" public-cloud/app.js || (echo "ERROR: hotword input parsing missing in cloud frontend" && exit 1)
	@echo "=== All QA checks passed ==="

clean:
	rm -rf dist/ recordings/

cloud-setup:
	@echo "=== Setting up remote environment on $(SSH_TARGET) ==="
	ssh $(SSH_TARGET) 'bash -s' < deploy/setup-remote.sh

cloud-build:
	@echo "=== Building cloud distribution ==="
	$(NPM) run build:cloud
	cp package.json package-lock.json dist/
	cp deploy/ecosystem.config.cjs dist/
	@echo "Build complete: dist/"

cloud-sync: cloud-build
	@echo "=== Syncing to $(SSH_TARGET):$(REMOTE_DIR) ==="
	ssh $(SSH_TARGET) "mkdir -p $(REMOTE_DIR)/recordings $(REMOTE_DIR)/logs"
	rsync -avz --delete --exclude='node_modules' --exclude='recordings/*' dist/ $(SSH_TARGET):$(REMOTE_DIR)/
	@echo "Sync complete"

cloud-deps:
	@echo "=== Installing production dependencies on remote ==="
	ssh $(SSH_TARGET) "cd $(REMOTE_DIR) && npm config set registry https://registry.npmmirror.com && npm install --production --loglevel=error"
	@echo "Dependencies installed"

cloud-deploy: cloud-sync cloud-deps
	@echo "=== (Re)starting service via PM2 ==="
	ssh $(SSH_TARGET) "cd $(REMOTE_DIR) && pm2 reload ecosystem.config.cjs --update-env || pm2 start ecosystem.config.cjs"
	ssh $(SSH_TARGET) "pm2 save"
	@echo "=== Service deployed ==="
	ssh $(SSH_TARGET) "pm2 status"

cloud-status:
	@ssh $(SSH_TARGET) "pm2 status"
	@echo "---"
	@curl -sk -o /dev/null -w "Direct HTTP (shcvm:$(CLOUD_PORT)): %{http_code}\n" http://$(CLOUD_IP):$(CLOUD_PORT)/api/config-schema 2>/dev/null || echo "Cannot reach service directly"
	@curl -sk -o /dev/null -w "Public HTTPS ($(CLOUD_PUBLIC_DOMAIN)$(CLOUD_PUBLIC_PATH)): %{http_code}\n" https://$(CLOUD_PUBLIC_DOMAIN)$(CLOUD_PUBLIC_PATH)/api/config-schema 2>/dev/null || echo "Cannot reach via public domain"

cloud-logs:
	ssh $(SSH_TARGET) "pm2 logs doubao-asr-cloud --lines 50 --nostream"

cloud-restart:
	ssh $(SSH_TARGET) "pm2 reload doubao-asr-cloud --update-env"

cloud-stop:
	ssh $(SSH_TARGET) "pm2 stop doubao-asr-cloud"

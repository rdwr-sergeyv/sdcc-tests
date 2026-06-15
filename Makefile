.DEFAULT_GOAL := help

KAFKA_BOOTSTRAP ?= kafkaQA:9092
KAFKA_DOCKER_NETWORK ?= lab
KAFKA_PRODUCER_UI_PORT ?= 3000
KAFKA_PRODUCER_UI_PID := .tmp/kafka-securityevent-producer-ui.pid
KAFKA_PRODUCER_UI_LOG := logs/kafka-securityevent-producer-ui.log

.PHONY: help run-dp-isolate run-dp-isolate-build-only run-dp-isolate-ui-only demo-short demo-playwright demo-short-playwright demo-short-resume test-dp-isolate test-dp-isolate-api test-dp-isolate-api-build-only test-dp-isolate-api-short test-dp-isolate-smoke dp-isolate dp-isolate\:start dp-isolate\:build-only dp-isolate\:ui-only dp-isolate\:restart dp-isolate\:rebuild dp-isolate\:stop dp-isolate\:status dp-isolate\:restore-ready dp-isolate\:patch-pending-task-deps dp-isolate\:task-snapshot dp-isolate\:device-password dp-isolate\:vision-password dp-isolate\:policy-capacity-min dp-isolate\:policy-capacity-restore dp-isolate\:set-policy-capacity set-policy-capacity restore-ready db-restore db-capture patch-pending-task-deps task-snapshot device-password vision-password policy-capacity-min policy-capacity-restore kafka-producer kafka-producer-ui kafka-producer-ui-up kafka-producer-ui-down kafka-producer-ui-status kafka-producer-ui-logs status dp-isolate-status portal-up portal-build-only-up portal-ui-up portal-restart portal-rebuild portal-down portal-logs portal-license-backends client-up client-down client-logs open-dp-isolate logs stop clean

help:
	@node tools/dp-isolate-dev.cjs help

run-dp-isolate:
	@node tools/dp-isolate-dev.cjs run

run-dp-isolate-build-only:
	@node tools/dp-isolate-dev.cjs run

run-dp-isolate-ui-only:
	@node tools/dp-isolate-dev.cjs run-ui-only

demo-short:
	@bash scripts/dp-isolate-short-demo.sh

demo-playwright:
	@node scripts/dp-isolate-short-demo.playwright.cjs --fresh --backend

demo-short-playwright:
	@node scripts/dp-isolate-short-demo.playwright.cjs --fresh

demo-short-resume:
	@node scripts/dp-isolate-short-demo.playwright.cjs --resume

test-dp-isolate:
	@$(MAKE) portal-up
	@$(MAKE) portal-license-backends
	@$(MAKE) restore-ready
	@npm run test:dp-isolate

test-dp-isolate-api:
	@$(MAKE) portal-up
	@$(MAKE) portal-license-backends
	@$(MAKE) restore-ready
	@npm run test:dp-isolate:api

test-dp-isolate-api-build-only:
	@$(MAKE) portal-up
	@$(MAKE) portal-license-backends
	@$(MAKE) restore-ready
	@npm run test:dp-isolate:api

test-dp-isolate-api-short:
	@$(MAKE) portal-ui-up
	@$(MAKE) restore-ready
	@npm run test:dp-isolate:api-short

test-dp-isolate-smoke:
	@$(MAKE) portal-up
	@$(MAKE) portal-license-backends
	@$(MAKE) restore-ready
	@npm run test:dp-isolate:smoke

dp-isolate: run-dp-isolate

dp-isolate\:start: run-dp-isolate

dp-isolate\:build-only: run-dp-isolate-build-only

dp-isolate\:ui-only: run-dp-isolate-ui-only

dp-isolate\:restart:
	@node tools/dp-isolate-dev.cjs restart

dp-isolate\:rebuild:
	@node tools/dp-isolate-dev.cjs rebuild

dp-isolate\:stop: stop

dp-isolate\:status: status

dp-isolate\:restore-ready:
	@npm run dp-isolate-fixtures:restore -- default --yes --preset dp-isolate

dp-isolate\:patch-pending-task-deps:
	@container="$${LEGACY_PORTAL_MONGO_CONTAINER:-legacy-portal-mongo-1}"; \
	db="$${SDCC_MONGO_DB:-sdcc}"; \
	if [ "$$(docker inspect -f '{{.State.Running}}' "$$container" 2>/dev/null)" != "true" ]; then \
		echo "  [missing] Mongo container $$container is not running."; \
		echo "  Start the lab first with 'make lab-start' or 'make lab-ui' from the cddos-legacy root."; \
		exit 1; \
	fi; \
	docker exec "$$container" mongosh "$$db" --quiet --eval 'const query = {status: "pending", $$or: [{dependencies: null}, {dependencies: {$$exists: false}}]}; const before = db.Tasks.countDocuments(query); const result = db.Tasks.updateMany(query, {$$set: {dependencies: []}}); printjson({matched: result.matchedCount, modified: result.modifiedCount, remaining: db.Tasks.countDocuments(query)});'

dp-isolate\:task-snapshot:
	@node tools/dp-isolate-task-snapshot.cjs $(ASSET_ID)

dp-isolate\:device-password:
	@if [ -n "$(VISION)" ]; then \
		node tools/decrypt-sc-device-password.cjs "$(SC)" --vision "$(VISION)" $(ARGS); \
	else \
		node tools/decrypt-sc-device-password.cjs "$(SC)" "$(DP)" $(ARGS); \
	fi

dp-isolate\:vision-password:
	@node tools/decrypt-sc-device-password.cjs "$(SC)" --vision "$(VISION)" $(ARGS)

dp-isolate\:policy-capacity-min:
	@node tools/dp-isolate-policy-capacity.cjs min

dp-isolate\:policy-capacity-restore:
	@node tools/dp-isolate-policy-capacity.cjs restore

dp-isolate\:set-policy-capacity:
	@if [ -z "$(SC)" ] || [ -z "$(DP)" ] || [ -z "$(N)" ]; then \
		echo "  [error] SC, DP and N are required: make set-policy-capacity SC=<SC name> DP=<DP name> N=<capacity>"; \
		exit 1; \
	fi
	@node tools/dp-isolate-policy-capacity.cjs set "$(SC)" "$(DP)" "$(N)"

restore-ready: dp-isolate\:restore-ready

db-restore:
	@npm run dp-isolate-fixtures:restore -- $(if $(NAME),$(NAME),default) --yes --preset dp-isolate

db-capture:
	@if [ -z "$(NAME)" ]; then \
		echo "  [error] NAME is required: make db-capture NAME=my-snapshot"; \
		exit 1; \
	fi
	@npm run dp-isolate-fixtures:capture -- $(NAME) $(if $(DESCRIPTION),--description "$(DESCRIPTION)",)

patch-pending-task-deps: dp-isolate\:patch-pending-task-deps

task-snapshot: dp-isolate\:task-snapshot

device-password: dp-isolate\:device-password

vision-password: dp-isolate\:vision-password

policy-capacity-min: dp-isolate\:policy-capacity-min

policy-capacity-restore: dp-isolate\:policy-capacity-restore

set-policy-capacity: dp-isolate\:set-policy-capacity

kafka-producer:
	@bash tools/kafka-securityevent-producer/run.sh --docker-network "$(KAFKA_DOCKER_NETWORK)" --bootstrap "$(KAFKA_BOOTSTRAP)" $(KAFKA_ARGS)

kafka-producer-ui:
	@if [ ! -d tools/kafka-securityevent-producer/ui/node_modules ]; then \
		echo "  [missing] Kafka producer UI dependencies are not installed."; \
		echo "  Run 'cd sdcc-tests/tools/kafka-securityevent-producer/ui && npm install', then retry."; \
		exit 1; \
	fi
	@cd tools/kafka-securityevent-producer/ui && PORT="$(KAFKA_PRODUCER_UI_PORT)" npm start

kafka-producer-ui-up:
	@if [ ! -d tools/kafka-securityevent-producer/ui/node_modules ]; then \
		echo "  [missing] Kafka producer UI dependencies are not installed."; \
		echo "  Run 'cd sdcc-tests/tools/kafka-securityevent-producer/ui && npm install', then retry."; \
		exit 1; \
	fi
	@mkdir -p .tmp logs
	@if [ -f "$(KAFKA_PRODUCER_UI_PID)" ] && kill -0 "$$(cat "$(KAFKA_PRODUCER_UI_PID)")" 2>/dev/null; then \
		echo "Kafka producer UI is already running at http://localhost:$(KAFKA_PRODUCER_UI_PORT) (pid $$(cat "$(KAFKA_PRODUCER_UI_PID)"))."; \
	else \
		root="$$(pwd)"; \
		cd tools/kafka-securityevent-producer/ui && PORT="$(KAFKA_PRODUCER_UI_PORT)" nohup npm start > "$$root/$(KAFKA_PRODUCER_UI_LOG)" 2>&1 & \
		echo "$$!" > "$(KAFKA_PRODUCER_UI_PID)"; \
		echo "Started Kafka producer UI at http://localhost:$(KAFKA_PRODUCER_UI_PORT) (pid $$(cat "$(KAFKA_PRODUCER_UI_PID)"))."; \
		echo "Log: $(KAFKA_PRODUCER_UI_LOG)"; \
	fi

kafka-producer-ui-down:
	@if [ -f "$(KAFKA_PRODUCER_UI_PID)" ]; then \
		pid="$$(cat "$(KAFKA_PRODUCER_UI_PID)")"; \
		if kill -0 "$$pid" 2>/dev/null; then \
			kill "$$pid"; \
			echo "Stopped Kafka producer UI process $$pid."; \
		else \
			echo "Kafka producer UI PID $$pid is not running."; \
		fi; \
		rm -f "$(KAFKA_PRODUCER_UI_PID)"; \
	else \
		echo "No Kafka producer UI PID found."; \
	fi

kafka-producer-ui-status:
	@if [ -f "$(KAFKA_PRODUCER_UI_PID)" ] && kill -0 "$$(cat "$(KAFKA_PRODUCER_UI_PID)")" 2>/dev/null; then \
		echo "Kafka producer UI is running at http://localhost:$(KAFKA_PRODUCER_UI_PORT) (pid $$(cat "$(KAFKA_PRODUCER_UI_PID)"))."; \
	else \
		echo "Kafka producer UI is not running."; \
	fi

kafka-producer-ui-logs:
	@if [ -f "$(KAFKA_PRODUCER_UI_LOG)" ]; then \
		tail -n 120 "$(KAFKA_PRODUCER_UI_LOG)"; \
	else \
		echo "No Kafka producer UI log found at $(KAFKA_PRODUCER_UI_LOG)."; \
	fi

status:
	@node tools/dp-isolate-dev.cjs status

dp-isolate-status: status

portal-up:
	@node tools/dp-isolate-dev.cjs portal-up

portal-build-only-up:
	@node tools/dp-isolate-dev.cjs portal-up

portal-ui-up:
	@node tools/dp-isolate-dev.cjs portal-ui-up

portal-restart:
	@node tools/dp-isolate-dev.cjs portal-restart

portal-rebuild:
	@node tools/dp-isolate-dev.cjs portal-rebuild

portal-up-build:
	@node tools/dp-isolate-dev.cjs portal-up-build

portal-down:
	@node tools/dp-isolate-dev.cjs portal-down

portal-logs:
	@node tools/dp-isolate-dev.cjs portal-logs

stack-up:
	@SDCC_HYBRID_PROFILE="$(SDCC_HYBRID_PROFILE)" SDCC_MONITOR_PROFILE="$(SDCC_MONITOR_PROFILE)" node tools/dp-isolate-dev.cjs stack-up

stack-restart:
	@SDCC_HYBRID_PROFILE="$(SDCC_HYBRID_PROFILE)" SDCC_MONITOR_PROFILE="$(SDCC_MONITOR_PROFILE)" node tools/dp-isolate-dev.cjs stack-restart

stack-up-build:
	@SDCC_HYBRID_PROFILE="$(SDCC_HYBRID_PROFILE)" SDCC_MONITOR_PROFILE="$(SDCC_MONITOR_PROFILE)" node tools/dp-isolate-dev.cjs stack-up-build

stack-rebuild:
	@SDCC_HYBRID_PROFILE="$(SDCC_HYBRID_PROFILE)" SDCC_MONITOR_PROFILE="$(SDCC_MONITOR_PROFILE)" node tools/dp-isolate-dev.cjs stack-rebuild

portal-license-backends:
	@DP_ISOLATE_COMPOSE_PROFILE="$(DP_ISOLATE_COMPOSE_PROFILE)" node tools/dp-isolate-dev.cjs portal-license-backends

client-up:
	@node tools/dp-isolate-dev.cjs client-up

client-down:
	@node tools/dp-isolate-dev.cjs client-down

client-logs:
	@node tools/dp-isolate-dev.cjs client-logs

open-dp-isolate:
	@node tools/dp-isolate-dev.cjs open

logs:
	@node tools/dp-isolate-dev.cjs logs

stop:
	@node tools/dp-isolate-dev.cjs stop

clean:
	@node tools/dp-isolate-dev.cjs clean

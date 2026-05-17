.DEFAULT_GOAL := help

.PHONY: help run-dp-isolate run-dp-isolate-ui-only dp-isolate dp-isolate\:start dp-isolate\:ui-only dp-isolate\:restart dp-isolate\:rebuild dp-isolate\:stop dp-isolate\:status dp-isolate\:restore-ready dp-isolate\:task-snapshot restore-ready task-snapshot status dp-isolate-status portal-up portal-ui-up portal-down portal-logs portal-license-backends client-up client-down client-logs open-dp-isolate logs stop clean

help:
	@node tools/dp-isolate-dev.cjs help

run-dp-isolate:
	@node tools/dp-isolate-dev.cjs run

run-dp-isolate-ui-only:
	@node tools/dp-isolate-dev.cjs run-ui-only

dp-isolate: run-dp-isolate

dp-isolate\:start: run-dp-isolate

dp-isolate\:ui-only: run-dp-isolate-ui-only

dp-isolate\:restart:
	@node tools/dp-isolate-dev.cjs restart

dp-isolate\:rebuild:
	@node tools/dp-isolate-dev.cjs rebuild

dp-isolate\:stop: stop

dp-isolate\:status: status

dp-isolate\:restore-ready:
	@npm run dp-isolate-fixtures:restore -- ready-for-tests --yes --preset dp-isolate

dp-isolate\:task-snapshot:
	@node tools/dp-isolate-task-snapshot.cjs $(ASSET_ID)

restore-ready: dp-isolate\:restore-ready

task-snapshot: dp-isolate\:task-snapshot

status:
	@node tools/dp-isolate-dev.cjs status

dp-isolate-status: status

portal-up:
	@node tools/dp-isolate-dev.cjs portal-up

portal-ui-up:
	@node tools/dp-isolate-dev.cjs portal-ui-up

portal-down:
	@node tools/dp-isolate-dev.cjs portal-down

portal-logs:
	@node tools/dp-isolate-dev.cjs portal-logs

portal-license-backends:
	@node tools/dp-isolate-dev.cjs portal-license-backends

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

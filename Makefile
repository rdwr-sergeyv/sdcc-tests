.DEFAULT_GOAL := help

.PHONY: help run-dp-isolate dp-isolate dp-isolate\:start dp-isolate\:restart dp-isolate\:rebuild dp-isolate\:stop dp-isolate\:status status dp-isolate-status portal-up portal-down portal-logs client-up client-down client-logs open-dp-isolate logs stop clean

help:
	@node tools/dp-isolate-dev.cjs help

run-dp-isolate:
	@node tools/dp-isolate-dev.cjs run

dp-isolate: run-dp-isolate

dp-isolate\:start: run-dp-isolate

dp-isolate\:restart:
	@node tools/dp-isolate-dev.cjs restart

dp-isolate\:rebuild:
	@node tools/dp-isolate-dev.cjs rebuild

dp-isolate\:stop: stop

dp-isolate\:status: status

status:
	@node tools/dp-isolate-dev.cjs status

dp-isolate-status: status

portal-up:
	@node tools/dp-isolate-dev.cjs portal-up

portal-down:
	@node tools/dp-isolate-dev.cjs portal-down

portal-logs:
	@node tools/dp-isolate-dev.cjs portal-logs

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

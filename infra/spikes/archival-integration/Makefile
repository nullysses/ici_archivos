SHELL := bash
.DEFAULT_GOAL := help

.PHONY: help check fetch bootstrap up preflight hierarchy transfer status verify logs

help: ## Show available spike commands.
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "%-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

check: ## Validate local scripts and required host tools.
	./bin/spike check

fetch: ## Fetch and verify the pinned upstream source trees.
	./bin/spike fetch

bootstrap: ## Initialize empty vendor databases (DESTRUCTIVE to spike data).
	./bin/spike bootstrap --confirm-reset

up: ## Start an already-bootstrapped spike.
	./bin/spike up

preflight: ## Verify service reachability, API auth, and processing profile.
	./bin/spike preflight

hierarchy: ## Create the API-driven Fonds/Section/Series/File test hierarchy.
	./bin/spike hierarchy

transfer: ## Submit the synthetic expediente to Archivematica.
	./bin/spike transfer

status: ## Poll transfer and ingest until completion or intervention.
	./bin/spike status

verify: ## Verify AIP/DIP jobs and the resulting AtoM digital object.
	./bin/spike verify

logs: ## Print recent AtoM and Archivematica service logs.
	./bin/spike logs


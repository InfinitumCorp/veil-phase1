PY ?= python3
WORK ?= work

.PHONY: patches test lint apple-logic preview demo clean

## Run every check that does not need a built browser.
test: lint apple-logic
	$(PY) -m pytest -q veil-qa/tests

## Fail-closed Tor gate. Foundation only, so it runs on the Linux CI runner.
apple-logic:
	bash apps/apple/scripts/test_logic.sh

lint:
	$(PY) veil-browser/tools/veil_patches.py lint veil-browser/patches
	bash -n veil-build/bootstrap.sh
	bash -n veil-build/build.sh

## Run the whole demo on this machine: Cumulus://ID, SCALVS.ai, /CNDCTR/ and
## the clickable VEIL prototype. Then open http://localhost:8410.
## Set ANTHROPIC_API_KEY first for real SCALVS.ai answers.
demo:
	node veil-prototype/run-demo.mjs

## Build a local preview of the dashboards, signed with a throwaway dev key.
## Open $(WORK)/preview/home/home.html.
preview:
	rm -rf $(WORK)/preview && mkdir -p $(WORK)/dev-keys $(WORK)/dev-trust
	cp -r veil-chrome/src $(WORK)/preview
	cp veil-chrome/registry/registry.json $(WORK)/dev-registry.json
	$(PY) veil-chrome/tools/registry_tool.py keygen $(WORK)/dev-keys/dev
	cp $(WORK)/dev-keys/dev.pub $(WORK)/dev-trust/dev.pub
	$(PY) veil-chrome/tools/registry_tool.py sign $(WORK)/dev-registry.json $(WORK)/dev-keys/dev.key
	$(PY) veil-chrome/tools/registry_tool.py build $(WORK)/dev-registry.json $(WORK)/dev-trust $(WORK)/preview/generated/registry.js

clean:
	rm -rf $(WORK)

# Recut both pending patch series from VEIL's sources (needs the upstream trees;
# see veil-browser/src/glue/PATCH-NOTES.md).
patches:
	@test -n "$(VEIL_UPSTREAM_SUBSET)" -a -n "$(VEIL_UPSTREAM_TBB)" || { echo "set VEIL_UPSTREAM_SUBSET and VEIL_UPSTREAM_TBB"; exit 2; }
	git -C "$(VEIL_UPSTREAM_SUBSET)" checkout -q -f -B veil upstream && git -C "$(VEIL_UPSTREAM_SUBSET)" clean -qfdx
	python3 -I veil-browser/tools/cut_patches.py "$(VEIL_UPSTREAM_SUBSET)" veil-browser/patches/pending
	git -C "$(VEIL_UPSTREAM_TBB)" checkout -q -f -B veil-16.0 tbb-16.0-build1
	python3 -I veil-build/tools/cut_build_patches.py "$(VEIL_UPSTREAM_TBB)" veil-build/patches/pending
	python3 veil-browser/tools/veil_patches.py lint --pending veil-browser/patches/pending
	python3 veil-browser/tools/veil_patches.py lint --pending veil-build/patches/pending

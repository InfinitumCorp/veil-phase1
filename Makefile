PY ?= python3
WORK ?= work

.PHONY: test lint preview clean

## Run every check that does not need a built browser.
test: lint
	$(PY) -m pytest -q veil-qa/tests

lint:
	$(PY) veil-browser/tools/veil_patches.py lint veil-browser/patches
	bash -n veil-build/bootstrap.sh
	bash -n veil-build/build.sh

## Build a local preview of the dashboards, signed with a throwaway dev key.
## Open $(WORK)/preview/anonymous/home.html or authenticated/home.html.
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

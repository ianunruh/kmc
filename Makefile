# kmc monorepo — console (Node) + controller (Go)

export GOTOOLCHAIN ?= auto

# Pin controller-gen for reproducible CRD/DeepCopy generation.
CONTROLLER_GEN ?= go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.17.3

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-22s %s\n", $$1, $$2}'

##@ Console

.PHONY: console-install
console-install: ## pnpm install in console/
	cd console && pnpm install

.PHONY: console-dev
console-dev: ## Run console dev server
	cd console && pnpm dev

.PHONY: console-build
console-build: ## Build console
	cd console && pnpm build

.PHONY: console-check
console-check: ## typecheck + lint + format check
	cd console && pnpm check

.PHONY: console-typecheck
console-typecheck: ## Typecheck console
	cd console && pnpm typecheck

##@ Controller

.PHONY: generate
generate: ## Generate DeepCopy + CRD manifests
	$(CONTROLLER_GEN) object:headerFile=hack/boilerplate.go.txt paths="./api/..."
	$(CONTROLLER_GEN) crd paths="./api/..." output:crd:artifacts:config=deploy/controller/crds
	$(CONTROLLER_GEN) rbac:roleName=kmc-controller paths="./internal/controller/..." output:rbac:artifacts:config=deploy/controller/rbac

.PHONY: controller-build
controller-build: ## Build kmc-controller binary to bin/
	go build -o bin/kmc-controller ./cmd/kmc-controller

.PHONY: controller-test
controller-test: ## Run Go tests
	go test ./...

.PHONY: controller-run
controller-run: controller-build ## Run controller against current kubeconfig (no leader election)
	./bin/kmc-controller --leader-elect=false

.PHONY: fmt
fmt: ## go fmt
	go fmt ./...

.PHONY: vet
vet: ## go vet
	go vet ./...

.PHONY: test
test: controller-test ## Alias for controller-test

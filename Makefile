.PHONY: test test-contract test-smoke

test:
	npm test

test-contract:
	npm run test:contract

test-smoke:
	npm run test:smoke

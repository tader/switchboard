deploy:
	docker compose build
	docker compose up -d

logs:
	docker compose logs -f

# One-time link to set the admin password (printed while no admin can sign in)
setup-link:
	docker compose logs 2>&1 | grep -A1 "No administrator" | tail -1

dev:
	docker compose -f docker-compose.dev.yml up -d

dev-logs:
	docker compose -f docker-compose.dev.yml logs -f

dev-stop:
	docker compose -f docker-compose.dev.yml down

test:
	npm test

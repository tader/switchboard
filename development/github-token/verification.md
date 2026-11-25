# Plugin installation token verification

The desktop token uses a dedicated environment setting and an internal installation context. The anonymous request must be rate limited before the token is tried. Existing configured credentials and explicitly selected connections retain their behavior.

Validation: TypeScript typechecking, all 39 focused plugin installation tests, and the full core test suite passed. Coverage includes dependency installation without a user connection, redirected downloads without authorization, anonymous public success, non-rate-limit failures, explicit connection isolation, update checks, update previews, and catalogs reached by update dependencies. Fixtures use synthetic plugin names and tokens.

No database migration or HTTP credential management endpoint is added. The token is held in server memory and is not added to persisted plugin sources or plans.

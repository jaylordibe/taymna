-- Hand-written migration: Prisma's schema DSL cannot express a partial
-- (filtered) unique index, so it's added directly here. This is the actual
-- database-level enforcement of "a machine cannot have multiple conflicting
-- active sessions" -- the service layer also pre-checks for a friendly 409,
-- but this constraint is the source of truth and holds under concurrency.
CREATE UNIQUE INDEX "one_active_session_per_machine" ON "sessions" ("machine_id") WHERE "status" = 'ACTIVE';

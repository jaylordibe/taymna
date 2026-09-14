-- Machine decommission lifecycle. A non-null value means "an operator has
-- requested removal and the machine is pending decommission"; the row and its
-- credential are kept valid until the still-installed agent reconnects, is
-- told to relinquish control, and acknowledges -- only then is the row deleted
-- (see docs/enrollment.md "Decommissioning a machine").
--
-- Additive and nullable on purpose: every existing machine gets NULL, i.e.
-- MANAGED, so a deploy of this migration leaves already-enrolled machines
-- behaving exactly as before.
ALTER TABLE "machines" ADD COLUMN "decommission_requested_at" TIMESTAMP(3);

-- A connector's definition travels under a UUID derived from its id
-- (ADR-0092 addendum). The id stays the catalog name its tokens, tools and
-- triggers are filed under, and the service only accepts UUID objects, so
-- the object id is kept beside it, here only. The app names the rows that
-- predate this column as it opens (connectors::assign_object_ids).
ALTER TABLE connectors ADD COLUMN object_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS connectors_object_id ON connectors(object_id);

-- What was queued under the old ids never reached the service and never will:
-- the service refused it. The issues it raised go, then the rows themselves,
-- and the app queues each connector again under its object id.
DELETE FROM account_sync_issues WHERE lane='outbox' AND item_id IN (SELECT operation_id FROM account_sync_outbox WHERE object_id IN (SELECT id FROM connectors) OR (json_valid(body) AND json_extract(body,'$.table')='connectors'));
DELETE FROM account_sync_outbox WHERE object_id IN (SELECT id FROM connectors) OR (json_valid(body) AND json_extract(body,'$.table')='connectors');

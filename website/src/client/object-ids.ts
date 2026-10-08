/**
 * The object a row travels under, as `sync_tables::object_of` says. A row is
 * its own object, except a connector: its id is a catalog name (`sentry`)
 * the account service refuses, so its object is the name-based UUID of the
 * id that `connectors::object_id` derives (ADR-0092 addendum). The row keeps
 * the id; only the object changes.
 */
import { uuidV5 } from "./saved";

/** `Uuid::NAMESPACE_URL`. */
const NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/** `connectors::object_id`. */
export function connectorObjectId(id: string): Promise<string> {
  return uuidV5(NAMESPACE_URL, `subrosa:connector:${id}`);
}

/** The object id a row of `table` with this id travels under, or null for a
 * row without a usable id. */
export async function objectIdOf(table: string, id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !id) return null;
  return table === "connectors" ? connectorObjectId(id) : id;
}

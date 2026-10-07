-- A reply rating goes with what it rates (ADR-0082).
-- Deleting a chat deletes its ratings, whichever path deletes it: the phone's
-- delete, leaving a temporary chat, the sweep at launch or a deletion that
-- arrives from another device. The phone keys a rating by the task id. A
-- desktop chat keys it by its Hermes session id, which a temporary or
-- portable desktop chat also stores on its task row.
-- A reply removed on its own (regenerated, or cut by an edit) takes its
-- rating too, since the reply it judged is gone.
-- A desktop chat with no task row is deleted through the runtime, and that
-- command deletes its ratings itself.
CREATE TRIGGER IF NOT EXISTS reply_ratings_follow_task_delete AFTER DELETE ON agent_tasks BEGIN
  DELETE FROM reply_ratings
  WHERE conversation_id = old.id
     OR (old.hermes_session_id IS NOT NULL AND conversation_id = old.hermes_session_id);
END;

CREATE TRIGGER IF NOT EXISTS reply_ratings_follow_message_delete AFTER DELETE ON agent_messages BEGIN
  DELETE FROM reply_ratings WHERE conversation_id = old.task_id AND message_id = old.id;
END;

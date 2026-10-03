# Sync conflict resolution (scope)

**Problem:** Flight's sync queue handles delivery — it retries with exponential backoff and shows the unsynced count — but it does not decide what happens when two offline edits collide. The ETag catches the collision: a stale write gets refused. But the refused write is not merged or flagged for a person. It just fails, and the second technician's changes are lost unless they re-enter them.

**Build:** Keep both versions, merge them, and flag the conflict for a person to resolve. Builds on the existing ETag on workspace writes and the append-only change log, which gives a replayable history.

**Tests:** A queued change pushes when the server returns. A conflict keeps both versions and flags them. The ETag still refuses a stale write.

**Status:** Scope agreed. Implementation not started.

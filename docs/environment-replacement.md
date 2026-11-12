# Replace an Agent's execution environment

Replacement preserves the Agent ID, owner, channel identities and communication
records. Native sessions, runs and pending calls are reset because they belong to
the old Host. The caller must pause the old environment first, finish or explicitly
resolve outstanding work, and close SSH sessions.

Use the locally built CLI:

```sh
mau pause
mau environment-replace TARGET_PROFILE
```

The equivalent API is `POST /_mau/v1/agents/:id/environment/replace` with
`profileId` and `expectedOperationId`. Ownership and profile assignment are checked;
the operation ID prevents replacing a binding that changed after inspection.
Read the environment endpoint for durable progress. A lost response is recovered
by reconciliation, not by allocating another environment. Bootstrap files are
explicit operator-selected profile inputs; replacement does not copy arbitrary
old filesystem contents automatically.

The old environment is left paused; provider retention limits can still expire it.
Keep independent file exports. Rollback verifies that the old environment still
exists and is paused before changing any binding. To roll back, pause the replacement and use
`mau environment-rollback`, or POST `/environment/rollback` with its current
`expectedOperationId`. Rollback restores the prior environment binding and starts
a fresh native session; it does not restore native conversation history. It leaves
the retired replacement allocated and paused for explicit operator cleanup.

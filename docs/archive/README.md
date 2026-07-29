# Archived one-shot runbooks

These documents are agent prompts that were written for a single pass of
work, executed, and then superseded. They are kept for the record of *how*
the HomeKit exposure was commissioned, but none of them should be run again:

- **HOMEKIT_EXCLUSIONS_PROMPT.md** — trimmed the HomeKit bridge by exclusion.
  Superseded: the bridge is now driven by an include-list (`knx/README.md`,
  item 9).
- **HOMEKIT_COVERS_INSTALL_PROMPT.md** — installed the `hk_*` template cover
  wrappers from `ha/homekit_covers.yaml`. Superseded 2026-07-26 when the 13
  native `cover.*_blinds_knx` entities replaced the wrappers.
- **HOMEKIT_ROOM_ASSIGNMENT_PROMPT.md** — first Apple Home room-assignment
  pass; ran against a bridge that was silently capping accessories.
- **HOMEKIT_ROOM_RECONCILE_PROMPT.md** — the reconcile pass that fixed the
  above. Its manifest predates the KNX cover swap, so re-running it would
  re-expose the retired wrapper covers.

Current state of the HomeKit/KNX work lives in `knx/README.md` and
`docs/COMMISSIONING_LOG.md`.

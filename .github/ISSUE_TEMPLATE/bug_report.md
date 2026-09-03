---
name: Bug report
about: Something in dsh-realtimeavatar misbehaves
labels: bug
---

**Before you paste anything:** never include your Realtime Avatar API key (`tic_live_…` /
`tic_test_…`), a bearer header, or your avatar and asset ids. Replace them with `<key>`,
`<avatar>` and `<asset>`. dsh-realtimeavatar redacts keys from its own output, but shell
history, logs and screenshots may still contain them. If a key has been exposed, revoke it
in the dashboard first: https://realtimeavatar.ai/platform/settings#api-keys

### What happened

<!-- the tool you called (rta_status / rta_session_mint / rta_avatar_create / …) or the
/rta sub-command, the arguments (ids redacted), and the exact error text as rendered in dsh,
including any RTA_KEY_* code -->

### What you expected

### `/rta status` output

<!-- paste it with the "API key (…)" line reduced to its posture, e.g.
     "- API key (REALTIME_AVATAR_API_KEY): configured via credentials, environment tag test"
     — that line never contains the value; if yours does, do not paste it -->

```text
```

### Environment

- dsh-realtimeavatar version:
- dsh version (`dsh --version`):
- Node version (`node --version`):
- Install method: npm registry / GitHub (`prepare` build) / local link
- Key source: `/rta key` (credential store) / `REALTIME_AVATAR_API_KEY` exported in the shell
- Plugin config (from your profile's cordis.patch.yml — the `apiKeyEnv` line is a name, not a value):

```yaml
```

### Approval gate

If a write tool (rta_avatar_create, rta_loop_set, rta_clips_set, rta_session_mint,
rta_asset_remote, rta_avatar_update, rta_avatar_delete) was denied or asked when you
did not expect it, paste the gate's reason line and your `readOnly` / `writeApproval`
settings. Credit-spending tools always ask; `readOnly: true` denies every write.

### Documentation drift

If a skill or `rta_docs` page disagrees with https://realtimeavatar.ai/docs, name the page
slug and quote the two versions (the skills are a dated snapshot; the date is in the first
line of each skill).

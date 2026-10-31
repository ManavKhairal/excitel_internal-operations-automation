# Workforce access — staging

This task grants or removes requested membership in the **first Sales User Group** in each explicitly requested tenant. The group is selected by position, then bound to its stable ID and actual name; it is not hardcoded to a particular employee's group name. Removal affects this group membership; account deletion, account deactivation and changes in other groups are separate operations.

## Credentials

The ignored local `.env` has independent fields:

```env
WORKFORCE_USERNAME=your_staging_username
WORKFORCE_PASSWORD=your_staging_password
```

They were initialized once from the existing Procare credentials as requested. Future changes to either application's password are independent. The task reads only the Workforce fields; it does not silently fall back to Procare credentials. `.env.example` contains placeholders only.

## Commands

Visible-browser preview, with no membership checkbox changes or saves:

```bash
npm start -- --task workforce-access --username new.agent1 --tenant both
```

Apply an approved staging request and verify persistence:

```bash
npm start -- --task workforce-access --username new.agent1 --tenant both --apply
```

Explicit action examples (replace `USERNAME` with an approved target):

```bash
# Grant membership
npm start -- --task workforce-access --username USERNAME --tenant both --action grant --apply

# Preview removal without changing membership
npm start -- --task workforce-access --username USERNAME --tenant both --action remove

# Remove membership and verify persistence
npm start -- --task workforce-access --username USERNAME --tenant both --action remove --apply
```

`--action grant` is the default to preserve existing commands. Removal requires explicit `--action remove`; neither action saves without `--apply`. The selected action is included in JSON/CSV reports and dispatched-write audit entries.

Choose `--tenant north`, `--tenant south` or `--tenant both` from the approved request. North/Delhi/DEL and South/Hyderabad/HYD aliases are accepted. Tenant is mandatory; the task never guesses it. Repeat `--username` for multiple users, up to the configured limit of 20 inputs. Case and leading zeroes are preserved; duplicate inputs are removed.

The browser is visible by default. Settings live in `config/workforce-access.json`. This version validates the reviewed staging Portal, Workforce and Auth0 URLs. A future production rollout requires reviewed configuration, origin guards and tests; replacing a URL alone does not enable production.

## Verified navigation and selectors

1. Open `https://staging-portal.excitel.in/choose-app` and sign in using the Workforce credentials at the approved prerelease Auth0 origin.
2. Select the Workforce tile by image alt text.
3. Select North India or South India; verify the Workforce header's `delhi` or `hyderabad` tenant button.
4. Select Sales, then `[data-id="user-groups-menu"]`. CAF Counters is a separate menu and is not the target of this task.
5. Select the first `[data-id="user-groups-body-column-name"]`, then verify its detail-route ID and `[data-id="name-form-value"]`.
6. Inspect persisted membership. For a new grant, open `[data-id="users-form-edit-icon"]` and search in `[data-id="users-form-dropdown-dropdown-search-input"]`. For removal, locate the exact checked member in the unfiltered selected-members dropdown; assigned users may not appear in the available-user endpoint.
7. Check persisted group membership first, since assigned users may be excluded from the available-user search. For a new member, require one exact username result in both the Users dropdown and the completed tenant-scoped lookup. Ignore prefix matches and other dropdowns.
8. In apply mode, check only an unselected requested user for grant, or uncheck only the selected requested member for removal. Require exactly `1 edited`, then click the unique Save inside `[data-id="user-groups-form-submit-bar"]` once.
9. Reload the exact group and verify the requested user's presence for grant or absence for removal. Verify every other member and group property stayed unchanged. Completion depends on this persisted list, not the Save footer disappearing or the available-user endpoint returning an already-assigned user.
10. For another tenant, use the current tenant button to return to the Workforce tenant chooser and repeat the flow. Its first group may have a different name and ID.
11. Sign out, verify that Portal and Workforce require login after reopening, and close the browser. Portal logout is also performed if its separate cached session is still authenticated.

Generated `css-*` class names are not used. North and South share the staging Workforce origin `https://staging-wf.excitel.in`; their API paths and selected tenant are distinct.

## Missing users and existing access

- If the exact username is absent in one tenant, record `USER_NOT_FOUND`, continue the remaining usernames/tenant, and name the missing tenant in the final report.
- If already selected during grant, record `ALREADY_MEMBER` without another Save. For removal, an available user already outside this group is `ALREADY_NOT_MEMBER` and is left unchanged.
- Duplicate exact matches, unknown checkbox states, tenant/group mismatches and failed lookups are errors, not evidence of absence.
- Existing membership in a different group is not automatically reassigned by this task.
- Removing the group's default user is blocked with `DEFAULT_USER_REMOVAL`: the default-user assignment must be changed separately first. The workflow does not choose a replacement automatically.
- An uncertain save stops further changes. The task never automatically replays Save; inspect the checkpoint and actual membership before another apply run.

## Save scope and preservation

The observed staging form submits a PUT to `/api/v1.0/{delhi|hyderabad}/UserGroup`. It sends the complete group, so request interception verifies more than the clicked checkbox:

- Explicit apply mode and a single armed user/group/tenant are required.
- Group ID, name, default user, default-group flag and other original properties must remain unchanged.
- For grant, every existing member remains unchanged and exactly the requested candidate is added. For removal, exactly the requested member is deleted from the list and every other member remains unchanged. Extra additions/deletions, member edits and unrelated fields are rejected.
- One dispatched save is allowed per user/group/tenant in a run.
- All navigation remains on approved staging/SSO origins. Known login/static resources and notification negotiation are allowed; unrelated writes are blocked.

The task preserves a durable checkpoint before Save. It re-queries the group through normal UI reloads and verifies actual saved membership; an optimistic checkbox change is insufficient. The first group is identified when entering each tenant and remains bound to that identity throughout its processing.

## Reports

Each invocation creates `output/<timestamp>-workforce-<username>/` with private `report.json` and `report.csv`; successful verifications can also capture screenshots. Reports include action, tenant, username, selected group, before/after membership, Save attempt, per-user outcome, dispatched-write audit and logout/browser cleanup results.

| Outcome | Meaning |
| --- | --- |
| `WOULD_GRANT_ACCESS` | Preview found the exact user, with membership unchanged. |
| `WOULD_REMOVE_ACCESS` | Preview found the exact selected member, with membership unchanged. |
| `USER_NOT_FOUND` | Exact user absent from the completed lookup for this tenant; other tenant processing continues. |
| `ALREADY_MEMBER` | Requested group membership already present; no Save. |
| `ALREADY_NOT_MEMBER` | User found outside this group during removal; no Save. |
| `ACCESS_GRANTED_VERIFIED` | Save sent once; membership and preservation verified after reopening. |
| `ACCESS_REMOVED_VERIFIED` | Save sent once; target absent and every other member/property preserved on readback. |
| `SAVE_STARTED_UNVERIFIED` | Durable checkpoint before Save; do not assume an interrupted run made no change. |
| `SAVE_UNVERIFIED` | Save persistence is uncertain or preservation could not be verified; no automatic retry. |
| `FAILED` / `NOT_PROCESSED` | A pre-save failure or a result not reached after the run halted. |

Missing users produce `COMPLETED_WITH_EXCEPTIONS` and exit code 2, while preserving successful outcomes in other tenants. A logout failure is reported separately from verified membership changes. The existing project run lock prevents simultaneous ERP/deposit/Workforce runs in this workspace.

## Files

- `src/workforce-cli.mjs`: CLI, credentials, lock and reports.
- `src/tasks/workforce-access.mjs`: workflow independent of the CLI and browser implementation.
- `src/integrations/workforce.mjs`: staging UI, readback, payload guards, tenant switching and logout.
- `config/workforce-access.json`: staging URLs, browser visibility and limits.
- `tests/workforce-fixture.mjs` and `tests/workforce.test.mjs`: isolated UI, request-guard, failure and CLI regressions.

Zendesk/email interpretation and authorization retrieval are future integrations. Today the operator supplies the username, approved tenant scope and explicit `--apply` flag.

Granting has live staging evidence from the initial implementation. Removal is covered by offline browser/request-guard tests; no real membership was removed while adding the remove option.

# Procare subscriber synchronization

This is a separate task for North production Procare, using a reviewed username list. ERP, deposit and Workforce tasks keep their own configuration and credentials.

## Current validation

The production sign-in page and application routes were reviewed, and prior authenticated runs produced verified synchronization responses. The checked-in configuration sets `liveUiReviewed` to `true`, so `--apply` can send production synchronization requests. Preview each new batch, confirm its source and exact usernames, and inspect the prior report before restarting an interrupted run. An offline test suite also covers the UI workflow and request guard. Branch cleanup did not execute the live task.

## Credentials

Fill the dedicated fields in the ignored local `.env`:

```env
PROCARE_SYNC_USERNAME=
PROCARE_SYNC_PASSWORD=
```

The task reads only these fields. It does not use staging Procare credentials as a fallback. Enter passwords locally, not in chat or `.env.example`.

## Sheet input

For a Google Sheet, provide its link, exact tab, username column, and selected rows or selection rule. The connected Google Sheets tools can read that bounded selection into a private `.state/procare-sync-users.json` snapshot. The Node.js process does not inherit Google authentication from the chat connector. JSON input does not autonomously refresh the sheet or write completion markers to it.

For a local Excel workbook, use `--workbook /path/to/users.xlsx`. The workbook must contain exactly one worksheet with exact `Username` and `Status` headers. Usernames must be stored as text to preserve leading zeroes. Preview does not edit the workbook. Apply creates a private backup before processing and updates only the matching `Status` cells. Keep the workbook closed during apply; an external edit stops the run rather than being overwritten. Completed `SYNCHRONIZED` and `USER_NOT_FOUND` rows are skipped. Uncertain earlier attempts require report review before their status cells are cleared and retried.

Snapshot format (example data only):

```json
{
  "tenant": "north",
  "source": {
    "spreadsheetId": "SHEET_ID",
    "tab": "Users",
    "range": "A2:A3",
    "checkedAt": "2026-10-30T00:00:00.000Z"
  },
  "usernames": ["example.user", "000123"]
}
```

Retain usernames as strings, including case and leading zeroes. Remove the header and blank rows during sheet extraction; an invalid username must be corrected or explicitly excluded before running. Duplicate usernames are processed once. A batch accepts at most the configured `maxUsers` (500); larger selections must be split explicitly, never silently truncated. Read a fresh snapshot for each new batch.

## Commands

Visible-browser preview:

```bash
npm start -- --task procare-subscriber-synchronization --input-file .state/procare-sync-users.json
```

Or preview a local workbook, optionally limiting the first batch:

```bash
npm start -- --task procare-subscriber-synchronization --workbook /path/to/users.xlsx --limit 10
```

After authenticated UI review, execute the approved batch:

```bash
npm start -- --task procare-subscriber-synchronization --input-file .state/procare-sync-users.json --apply
```

For a reviewed workbook batch, use the same `--workbook` path and optional `--limit` with `--apply`.

Preview searches and opens profiles without synchronization. The browser remains visible by default. The task shares the existing local execution lock.

## Workflow and verification

1. Sign in to the supplied North production Procare application using its reviewed production Auth0 origin.
2. Click Subscribers and fill `UserID or #Number` with the username.
3. Wait for the completed search response for that exact input. Require a complete result set and a unique exact username; do not select a person using their display name alone.
4. Click the exact username's row. Verify the opened route, username, subscriber ID, ERP subscriber ID, synchronization permission and enabled button.
5. In apply mode, checkpoint the intended action before clicking Synchronize once.
6. Allow only the synchronization request for that exact username and both verified subscriber IDs. Despite changing server state, Procare sends this action as a **GET** to `synchronization/syncSubscriber`; ordinary GET handling must never bypass this check. Other unreviewed API actions are blocked.
7. Require a successful HTTP/business response containing the same subscriber identity; reload the profile and verify its identity again. `SYNC_RESPONSE_VERIFIED` means Procare acknowledged the operation and the same profile reopened. It does not independently prove the state of every downstream system.
8. Return to Subscribers for the next user. Record missing users and continue; ambiguous identity, permission failures, unexpected requests or an uncertain synchronization stop further processing. Never automatically repeat a synchronization after a timeout or lost response.
9. Sign out, reopen Procare to verify login is required, close the browser and finish JSON/CSV reports.

## Reports and interrupted runs

`output/<timestamp>-procare-sync-<first-user>/` contains a report and verification screenshots. Reports include sheet source, input hash, per-user identities, attempt and dispatch checkpoints, response verification, blocked requests and logout results.

An interrupted run may already have sent Synchronize even if the report is incomplete. Review `SYNC_STARTED_UNVERIFIED`, `SYNC_UNVERIFIED` and the request audit before starting another run. The workbook records these uncertain states; it does not automatically resume or replay prior attempts. The fixture tests use temporary workbooks and perform no live Google Sheet or subscriber synchronization.

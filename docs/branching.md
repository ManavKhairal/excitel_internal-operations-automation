# Branching and recovery

`main` is the stable integration branch. ERP employee deactivation is part of its baseline. The tag `erp-deactivation-stable-2026-10-27` and branch `maintenance/erp-employee-deactivation` point to the original working ERP commit. Neither needs to be merged into `main` again.

For a new feature or fix, start a short-lived branch from the latest `main`. Keep one feature per pull request and merge with a merge commit after the relevant checks pass. Add a known-good tag after a release. Avoid rebasing or force-pushing a branch after it has been reviewed.

The first multi-task integration has a shared dispatcher plus separate Deposit, Workforce, and Procare feature commits. The original stacked branches remain as historical recovery points. The isolated branches can be reviewed independently; each starts from the shared dispatcher commit.

To roll back a feature already merged into `main`, create a rollback branch from the latest `main`, revert that feature's merge commit with `git revert -m 1 <merge-commit>`, resolve any shared-file conflicts, run `npm run check` and `npm test`, then merge the rollback. If a later feature depends on the one being reverted, roll back the dependent feature first. Do not reset or force-push `main`.

For future ERP fixes, branch from the latest `main` so the fix is tested with current tasks. If the old ERP-only line also needs the fix, cherry-pick that specific fix onto `maintenance/erp-employee-deactivation` and test it there. Keep the ERP tag unchanged as a known-good recovery point.

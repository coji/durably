# Publishing a release

Prepare the version and changelog in a pull request and merge it after CI passes. The GitHub release workflow publishes both npm packages, then creates the GitHub Release and tag. Do not create the tag beforehand.

## One-time npm setup

For **each** package, `@coji/durably` and `@coji/durably-react`, add a GitHub Actions Trusted Publisher in npm package settings with these exact values:

| Field             | Value         |
| ----------------- | ------------- |
| GitHub owner      | `coji`        |
| Repository        | `durably`     |
| Workflow filename | `release.yml` |
| Environment       | none          |

Allow the publisher to run `npm publish` directly rather than requiring a staged publish. The workflow uses GitHub OIDC, so it needs no `NPM_TOKEN` or per-release OTP. Configure both packages before the first workflow run; otherwise the first publish may succeed while the second fails. npm versions cannot be overwritten, so the workflow checks the commit of an already published version before skipping it on a retry.

## Run the release

1. Verify that the main-branch CI run for the merged release-preparation commit passed and that both package manifests and `CHANGELOG.md` contain the same version.
2. In GitHub, open **Actions → Release → Run workflow**, select `main`, and enter the version without the `v` prefix (for example, `0.16.0`).
3. Confirm that both npm packages have the version and the workflow created the `v<version>` GitHub Release. If a publish fails, correct the Trusted Publisher configuration and rerun the same workflow on the same main commit. The workflow skips only packages whose registry `gitHead` matches that commit.

The workflow refuses to publish from a non-main ref, from a commit that is no longer main, before successful main CI, when package versions or changelog disagree, or after the release tag exists. It builds and inspects both package tarballs before publishing the core package and then the React package. Creating the GitHub Release is the final step, after both publish commands succeed.

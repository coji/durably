# Publishing a release

Prepare the version and changelog in a pull request and merge it after CI passes. The GitHub release workflow publishes both npm packages, then creates the GitHub Release and tag. Do not create the tag beforehand.

## One-time npm setup

For **each** package, `@coji/durably` and `@coji/durably-react`, add a GitHub Actions Trusted Publisher in npm package settings with these exact values:

| Field             | Value         |
| ----------------- | ------------- |
| GitHub owner      | `coji`        |
| Repository        | `durably`     |
| Workflow filename | `release.yml` |
| Environment       | `npm-publish` |

Allow the publisher to run `npm publish` directly rather than requiring a staged publish. The workflow uses GitHub OIDC, so it needs no `NPM_TOKEN` or per-release OTP. The GitHub `npm-publish` environment must allow only the `main` branch; this repository already has that policy. Configure both packages before the first workflow run; otherwise the first publish may succeed while the second fails. npm versions cannot be overwritten, so the workflow records the release commit in each tarball and checks both that commit and the registry tarball integrity before skipping an already published version on a retry.

## Run the release

1. Verify that the main-branch CI run for the merged release-preparation commit passed and that both package manifests and `CHANGELOG.md` contain the same version.
2. In GitHub, open **Actions → Release → Run workflow**, select `main`, and enter the version without the `v` prefix (for example, `0.16.0`).
3. Confirm that both npm packages have the version and the workflow created the `v<version>` GitHub Release. If a publish fails, correct the Trusted Publisher configuration and rerun the same workflow while its commit is still current `main`. The workflow skips only packages whose registry `gitHead` and tarball integrity match that commit and the current artifact. If `main` has moved after a partial publish, recovery requires a new version-preparation PR because npm versions cannot be replaced from the newer commit.

The workflow refuses to publish from a non-main ref, from a commit that is no longer main when publishing starts, before successful main CI, when package versions, the React peer range, or changelog disagree, or after the release tag exists. A read-only build job installs dependencies and produces the two inspected tarballs. A publish job receives those artifacts, publishes the core package and then the React package through npm OIDC, and creates the GitHub Release after both succeed. Checkout credentials are not persisted in this job, and its GitHub token is exposed only to the final Release step.

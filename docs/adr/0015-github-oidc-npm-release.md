# ADR-0015: Publish npm releases from GitHub Actions through OIDC

## Status

accepted

## Context

The project publishes two packages. Local `npm publish` requires a browser OTP for each package, making a release depend on the maintainer's terminal session. A release also needs the prepared versions, changelog, successful CI, and GitHub Release to refer to the same commit.

## Decision

Use a manually dispatched GitHub Actions workflow on `main` as the release entry point. Configure each npm package to trust that workflow through GitHub OIDC and allow direct publishing. Verify that the workflow commit is current `main`, the main-push CI run succeeded, both manifest versions and changelog match the requested version, and both built tarballs include their distribution and package documentation. Publish the core package before the React package; skip an already published version only if its npm `gitHead` is this commit. Create the GitHub Release and tag only after both packages are published.

The version bump and changelog remain in an ordinary reviewed pull request. The release workflow never changes repository source files.

## Consequences

- Each npm package needs one-time Trusted Publisher registration. Publishing no longer needs a long-lived npm token or interactive OTP.
- A failed second publish can be retried on the same commit without trying to overwrite the first immutable npm version.
- A release cannot start until main CI succeeds, and a moved main branch requires a new run.
- The release tag marks successful publication of both packages rather than beginning the publish process.

## Rejected Alternatives

- Keep publishing from a local terminal: this retains two interactive OTP steps and makes the GitHub Release a separate manual operation.
- Store an npm automation token in GitHub secrets: this creates a long-lived publishing credential to rotate and protect.
- Publish automatically on every version commit or tag: a release would start without an explicit final invocation, and a tag could exist even if one package failed.

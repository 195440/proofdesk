# Workflow definitions

These are the project's GitHub Actions definitions, kept here as documents:

- `ci.yml` — run the test suite and a demo replay check on push / pull request.
- `refresh.yml` — optional daily refresh of the published site with live data.
  It does nothing until the repository secret `SOSOVALUE_API_KEY` exists.

To enable them on GitHub, copy both files to `.github/workflows/` in the
repository (the publishing token used for the first public push did not carry
the `workflow` scope, so they are shipped in this folder instead of in place).

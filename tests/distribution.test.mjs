import test from "node:test";
import assert from "node:assert/strict";
import {
  currentRepositorySlug,
  distributionFor,
  parseRepositorySlug,
} from "../scripts/repository-config.mjs";

test("repository resolver accepts Actions slug, HTTPS, and SSH forms", () => {
  for (const value of [
    "owner/project",
    "https://github.com/owner/project.git",
    "git@github.com:owner/project.git",
    "ssh://git@github.com/owner/project.git",
    "github.com/owner/project",
  ])
    assert.equal(parseRepositorySlug(value), "owner/project", value);
  for (const value of [
    "https://gitlab.com/owner/project",
    "https://github.com/owner/project/tree/main",
    "owner/project/extra",
    "",
  ])
    assert.equal(parseRepositorySlug(value), undefined, value);
});

test("distribution URLs are derived from the repository slug", () => {
  const config = distributionFor("owner/project");
  assert.equal(
    config.pluginCatalogUrl,
    "https://github.com/owner/project/releases/download/plugin-channel/catalog.json",
  );
  assert.equal(
    config.appReleaseUrl,
    "https://github.com/owner/project/releases/latest/download/Chord.Control-setup.exe",
  );
});

test("explicit build repository takes precedence over the checked-out origin", (t) => {
  const previous = process.env.CHORD_CONTROL_REPOSITORY;
  t.after(() => {
    if (previous === undefined) delete process.env.CHORD_CONTROL_REPOSITORY;
    else process.env.CHORD_CONTROL_REPOSITORY = previous;
  });
  process.env.CHORD_CONTROL_REPOSITORY = "fork/desktop";
  assert.equal(currentRepositorySlug(), "fork/desktop");
});

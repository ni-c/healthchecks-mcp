import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The parts of the supply chain that are one edit away from being wrong, and
 * that nothing else in this repository would notice.
 *
 * A workflow file is not code and gets no review from the type checker, the
 * linter or the test suite. These assertions are cheap and they fail in the same
 * run as everything else — which is the only reason a rule like "the job that
 * holds an OIDC token must not run install hooks" stays true a year from now.
 */
function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    'utf8'
  );
}

const release = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml');
const dockerfile = read('Dockerfile');

describe('the jobs that hold a token', () => {
  it('never runs a dependency install hook while publishing', () => {
    // The publish job has `id-token: write` for npm Trusted Publishing, so a
    // postinstall script in any transitive dependency would run with an OIDC
    // token available to it. The audit job and the Dockerfile already installed
    // with --ignore-scripts; this one did not.
    const publishJob = release.slice(release.indexOf('  publish:'));
    const installs = [...publishJob.matchAll(/run: npm ci.*/g)].map(
      (match) => match[0]
    );
    expect(installs.length).toBeGreaterThan(0);
    for (const install of installs) {
      expect(install).toContain('--ignore-scripts');
    }
  });

  it('proves nothing that ships needs one', () => {
    // The claim above is only safe while it is true, so it is checked rather
    // than remembered. The one package in the tree with an install hook is
    // `fsevents`: a macOS-only optional *dev* dependency of the test runner,
    // which npm does not install on the Linux runner that publishes and which
    // is not in the published package at all. Anything else appearing here is a
    // hook that would run in a job holding an OIDC token.
    const lock = JSON.parse(read('package-lock.json')) as {
      packages: Record<
        string,
        { hasInstallScript?: boolean; dev?: boolean; optional?: boolean }
      >;
    };
    const withHooks = Object.entries(lock.packages)
      .filter(
        ([, entry]) =>
          entry.hasInstallScript === true &&
          !(entry.dev === true && entry.optional === true)
      )
      .map(([name]) => name);
    expect(withHooks).toEqual([]);
  });

  it('refuses to release a tag that is not in the repository', () => {
    expect(release).toContain('--verify-tag');
  });

  it('pins the publisher it downloads, and checks its sha256', () => {
    expect(release).toContain('MCP_PUBLISHER_VERSION: v');
    expect(release).toContain('sha256sum -c -');
    expect(release).not.toContain('releases/latest/download');
  });
});

describe('what a pull request is checked against', () => {
  it('reviews the dependencies a change adds, not only the tree it lands in', () => {
    expect(ci).toContain('actions/dependency-review-action@');
    expect(ci).toContain('fail-on-severity: high');
  });

  it('pins every action to a commit, never to a tag', () => {
    for (const workflow of [
      'ci.yml',
      'release.yml',
      'docs.yml',
      'scorecard.yml',
    ]) {
      const text = read(`.github/workflows/${workflow}`);
      for (const [, ref] of text.matchAll(/uses: [^\s@]+@([^\s]+)/g)) {
        expect(ref).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});

describe('the runtime image', () => {
  it('carries no package manager', () => {
    // npm is a frequent source of HIGH findings and this image never installs
    // anything. yarn and corepack are the same argument, and they survived the
    // line that removed npm.
    for (const removed of ['npm', 'npx', 'corepack', 'yarn']) {
      expect(dockerfile).toMatch(
        new RegExp(`rm -rf[^\\n]*(\\\\\\n[^\\n]*)*${removed}`)
      );
    }
  });

  it('does not ship a lockfile nothing reads', () => {
    const runtime = dockerfile.slice(dockerfile.indexOf('# Runtime'));
    expect(runtime).toContain('COPY package.json ./');
    expect(runtime).not.toContain('package-lock.json');
  });

  it('installs with --ignore-scripts in the build stage', () => {
    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).toContain('npm prune --omit=dev --ignore-scripts');
  });

  it('pins the base image by digest and drops root', () => {
    expect(dockerfile).toMatch(/FROM node:24-alpine@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain('USER node');
  });
});

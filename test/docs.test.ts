import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_TOOLS,
  ESSENTIAL_TOOLS,
  READ_TOOLS,
} from '../src/tools/catalogue.js';

/**
 * The tool reference is written by hand, so this is what stops it drifting from
 * the catalogue.
 *
 * The alternative — generating the page — buys the same guarantee for fourteen
 * tools at the cost of a generator nobody reads and prose nobody can edit. A test
 * that fails by name when a tool is added, renamed or moved into the preset is
 * the cheaper half of it, and it fails in the same run as everything else.
 */
function read(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    'utf8'
  );
}

const reference = read('docs/reference/tools.md');

/** Every `### \`tool_name\`` heading, in the order the page lists them. */
function documentedTools(markdown: string): string[] {
  return [...markdown.matchAll(/^### `([a-z0-9_]+)`/gm)].map(
    (match) => match[1] as string
  );
}

/** The tools whose section carries the **essential** marker. */
function markedEssential(markdown: string): string[] {
  const sections = markdown.split(/^### /m).slice(1);
  return sections
    .filter((section) => /\*\*essential\*\*/.test(section))
    .map((section) => /^`([a-z0-9_]+)`/.exec(section)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('the tool reference', () => {
  it('documents every tool and no tool that does not exist', () => {
    expect(documentedTools(reference).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('marks exactly the essential preset', () => {
    expect(markedEssential(reference).sort()).toEqual(
      [...ESSENTIAL_TOOLS].sort()
    );
  });

  it('keeps the read tools ahead of the write tools', () => {
    const documented = documentedTools(reference);
    const lastRead = Math.max(
      ...(READ_TOOLS as readonly string[]).map((tool) =>
        documented.indexOf(tool)
      )
    );
    const firstWrite = Math.min(
      ...documented
        .filter((tool) => !(READ_TOOLS as readonly string[]).includes(tool))
        .map((tool) => documented.indexOf(tool))
    );
    expect(lastRead).toBeLessThan(firstWrite);
  });
});

describe('the fixed cross-document anchors', () => {
  // These headings are linked from several places and are spelled identically in
  // every server of this family, so a rename here quietly breaks links there.
  it('keeps the README anchor for the tool filter', () => {
    expect(read('README.md')).toContain('### Choosing which tools load');
    expect(read('README.md')).toContain('(#choosing-which-tools-load)');
  });

  it('keeps the docs anchor for the tool filter', () => {
    expect(read('docs/guide/configuration.md')).toContain(
      '## Choosing the tools that load'
    );
    for (const page of ['docs/reference/environment.md', 'docs/guide/faq.md']) {
      expect(read(page)).toContain('#choosing-the-tools-that-load');
    }
  });

  it('keeps the changelog include by region, never by line range', () => {
    // A line range depends on how long the file's header happens to be and fails
    // silently when it grows — the newest release simply stops appearing.
    expect(read('docs/reference/changelog.md')).toContain(
      '<!--@include: ../../CHANGELOG.md#changelog-->'
    );
    const changelog = read('CHANGELOG.md');
    expect(changelog).toContain('<!-- #region changelog -->');
    expect(changelog.trimEnd().endsWith('<!-- #endregion changelog -->')).toBe(
      true
    );
  });
});

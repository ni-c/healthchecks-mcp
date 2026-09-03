/**
 * The annotation block every reading tool of this server carries.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * `openWorldHint: false` is the honest answer here: this server talks to the one
 * Healthchecks instance it is configured for. The specification's own example
 * draws the line there — a web search is an open world, a service you point at
 * is not.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

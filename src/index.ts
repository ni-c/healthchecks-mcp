#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig, missingConfigKeys } from './config.js';
import { createServer } from './server.js';
import { ToolFilterError } from 'mcp-tool-allowlist';

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.insecureTls) {
    console.error(
      'healthchecks-mcp: HEALTHCHECKS_INSECURE_TLS=true — TLS certificate validation is disabled for the Healthchecks connection'
    );
  }
  if (config.readOnly) {
    console.error(
      'healthchecks-mcp: HEALTHCHECKS_READ_ONLY=true — write tools are not registered'
    );
  }

  let server;
  try {
    server = createServer(config);
  } catch (error) {
    // A bad tool list is operator feedback, not a crash: print the sentence on
    // its own rather than behind "fatal error:" with a stack after it.
    if (error instanceof ToolFilterError) {
      console.error(`healthchecks-mcp: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  // stdout belongs to the protocol; everything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  const target = config.usingDefaultUrl
    ? `${config.url} (default — set HEALTHCHECKS_URL for a self-hosted instance)`
    : config.url;
  console.error(
    missingConfigKeys(config).length === 0
      ? `healthchecks-mcp: connected, targeting ${target}`
      : 'healthchecks-mcp: connected without an API key — tools are listed, but only get_status will work'
  );
}

// In a container node runs as PID 1 with no default signal disposition, so
// without this handler `docker stop` waits out the grace period and SIGKILLs.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error('healthchecks-mcp: fatal error:', error);
  process.exit(1);
});

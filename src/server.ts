import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/server';

import { HealthchecksApi } from './api.js';
import type { Config } from './config.js';
import { ConfirmationStore } from './confirm.js';
import { buildToolFilter, installToolFilter } from './tool-filter.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function createServer(config: Config): McpServer {
  // Before anything is built: an unusable tool list should fail on the way in,
  // not leave a server running with tools quietly missing.
  const filter = buildToolFilter(config);

  const api = new HealthchecksApi(config);
  const confirmations = new ConfirmationStore();

  const server = new McpServer({
    name: 'healthchecks-mcp',
    version: packageVersion(),
  });

  // Wraps server.registerTool, so it has to sit before the first register call
  // and it does not care how the register functions are organised.
  installToolFilter(server, filter);

  registerReadTools(server, api);
  // Read-only mode does not register the write tools at all. Rejecting them at
  // call time would still advertise capabilities the server refuses to provide.
  if (!config.readOnly) {
    registerWriteTools(server, api, confirmations);
  }

  return server;
}

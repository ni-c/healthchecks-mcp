import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Waits for the throwaway Healthchecks and hands back both API keys.
 *
 * Short, because the work happens in `compose.yml`: the image **ignores**
 * `SUPERUSER_EMAIL` and `SUPERUSER_PASSWORD` — they appear in plenty of
 * examples and create nothing, so the login form answers "Incorrect" for an
 * account that was never made — and Healthchecks' only headless way in is
 * `manage.py`. The account, the project and both keys are therefore created by
 * the container before uwsgi starts.
 *
 * **Both keys, on purpose.** Healthchecks gives a read-only key a real
 * read-only view rather than a partial one: three tools answer 401 with it,
 * and that is behaviour worth pinning rather than a limitation to work
 * around. The suite drives two servers, one per key.
 */

/** Matches the values `compose.yml` writes into the project. */
export const READ_WRITE_KEY = 'i'.repeat(32);
export const READ_ONLY_KEY = `hcr_${'r'.repeat(28)}`;

export interface Sandbox {
  url: string;
  /** Environment for a server holding the read-write key. */
  env: Record<string, string>;
  /** Environment for a server holding the read-only key. */
  readOnlyEnv: Record<string, string>;
}

export async function bootstrap(
  url = 'http://127.0.0.1:8000'
): Promise<Sandbox> {
  assertLoopback(url);
  // `/api/v3/status/` is public and is what the image's own healthcheck uses.
  // It answers 500 while the database is unwritable, which is the failure mode
  // a tmpfs mounted with the default 0755 produces — see the note in
  // compose.yml.
  await waitForHttp(`${url}/api/v3/status/`, {
    timeoutSeconds: 180,
    ready: (response) => response.ok,
  });

  // The key is what the container was told to write, so a mismatch here means
  // the seeding step did not run — and the first tool call would otherwise
  // report an authentication problem instead.
  const probe = await fetch(`${url}/api/v3/checks/`, {
    headers: { 'x-api-key': READ_WRITE_KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!probe.ok) {
    throw new Error(
      `Healthchecks did not accept the seeded API key (HTTP ${probe.status}). ` +
        'The account, project and keys are created by the container command in ' +
        'compose.yml before uwsgi starts — `docker compose logs` shows the ' +
        'line it prints.'
    );
  }

  return {
    url,
    env: {
      HEALTHCHECKS_URL: url,
      HEALTHCHECKS_API_KEY: READ_WRITE_KEY,
      HEALTHCHECKS_READ_ONLY: 'false',
    },
    readOnlyEnv: {
      HEALTHCHECKS_URL: url,
      HEALTHCHECKS_API_KEY: READ_ONLY_KEY,
    },
  };
}

/**
 * Pings a check the way a monitored job would.
 *
 * Not a tool: this server deliberately cannot ping, because a monitoring
 * client that can report success is a monitoring client that can lie. So the
 * suite has to do it itself to give `list_pings`, `get_ping_body` and
 * `list_flips` anything to read.
 */
export async function ping(
  url: string,
  uuid: string,
  options: { body?: string; suffix?: string } = {}
): Promise<void> {
  const suffix = options.suffix === undefined ? '' : `/${options.suffix}`;
  const response = await fetch(`${url}/ping/${uuid}${suffix}`, {
    method: 'POST',
    body: options.body ?? '',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ping failed: HTTP ${response.status}`);
  }
}

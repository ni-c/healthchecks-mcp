# What is healthchecks-mcp?

An MCP server for [Healthchecks](https://healthchecks.io), the dead man's switch
for cron jobs and scheduled tasks. Healthchecks works the other way round from an
uptime monitor: instead of polling your service, it waits for your job to check
in, and raises an alarm when the ping does not arrive. This server puts that data
— and the ability to change it — inside an MCP client.

It speaks the Management API v3 and works the same against the hosted service and
against a self-hosted instance.

## Why

Because the interesting question is never "is anything red". You can see that on
the dashboard. The interesting question is the next one: *what did it print when
it failed*, *when did it start*, *has it been flapping*, *and does the check even
have the right schedule*. Answering it means the ping list, then one ping's body,
then the flip history — three lookups that a model can chain in one turn and a
person does by clicking.

The second reason is quieter. Healthchecks has a handful of edges that are easy to
get wrong and silent when you do: `schedule` discards `timeout` without saying so,
`tags` are space-separated while keyword filters are comma-separated, `channels`
replaces rather than merges, and a check created without `channels` alerts nobody
at all. This server refuses the combinations that lose data and defaults the one
that matters, instead of forwarding the mistake.

## What it is not

- **It is not a pinger.** No tool here calls a ping URL. Pinging is a job's
  statement that it ran; a tool that could ping would let a model — or text a
  model happened to read — report success for something that never executed, and
  a monitoring system that can be talked into green is worse than no monitoring.
- **It is not a Healthchecks administrator.** Projects, members, ping keys and
  notification integrations are configured in the web UI; the Management API has
  no endpoints for them. `list_integrations` reads them so the write tools can
  refer to them by UUID.
- **It is not a multi-project view.** A Healthchecks API key belongs to exactly
  one project. To reach two, run two instances of this server with two keys.
- **It is not an archive.** The instance keeps 100 pings per check on a free plan
  and 1000 on a paid one, with no pagination and no way to reach past that, and
  flips only go back to the start of the month before last.

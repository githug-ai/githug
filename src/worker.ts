/**
 * Cloudflare Worker entry: the githug service on its own (src/core.ts). This is what the
 * self-hosted Cloudflare deployment (scripts/self-host.sh) and the Node container
 * (src/node/main.ts) run.
 */
import * as core from "./core.js";

export default {
  fetch: core.fetch,
  // Await the run directly rather than ctx.waitUntil(): waitUntil ties the work to the
  // triggering invocation and can cut it short.
  async scheduled(_event: ScheduledController, env: core.Env, _ctx: ExecutionContext): Promise<void> {
    await core.scheduled(env);
  },
};

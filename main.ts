// The entry <-> env lifecycle: bind an ephemeral port, tell the env which port it is,
// then poll until the env says the trial is over and exit 0.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing to talk to,
//      so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 —
//      the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request
//      came from plus N as the base URL and dials it from then on. The first register wins;
//      a 409 means another entry already registered, and this process keeps waiting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll, not a long-held request.
//      A failed or slow poll is retried with a short exponential backoff; the process never
//      exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export
//      the scorer reads.
//
// Two improvements over the bare lifecycle this file is built from:
//   - register() gives up after REGISTER_DEADLINE_MS instead of retrying forever: the env's
//     boot budget is 20 s, so an env that has not accepted a register in a full minute is
//     never going to, and exiting 1 with a clear message beats hanging until the wall budget.
//   - waitForDone() reports a non-OK /done answer on stderr instead of swallowing it silently,
//     so a misconfigured env URL is diagnosable from the log while polling continues.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;
/** Give up registering after this long: the boot budget is long past by then. */
const REGISTER_DEADLINE_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409 means a first
 * register already won, which is not this process's to fix. 400 and 405 are contract errors
 * and end the program; a network error or another status is retried, since the env may still
 * be starting — but only until REGISTER_DEADLINE_MS has passed.
 */
async function register(port: number): Promise<void> {
  const startedAt = performance.now();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    if (performance.now() - startedAt > REGISTER_DEADLINE_MS) {
      throw new Error(`register did not succeed within ${REGISTER_DEADLINE_MS} ms: the env is not accepting registrations`);
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      } else {
        process.stderr.write(`[entry] /done answered HTTP ${res.status}; still polling\n`);
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Bind the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

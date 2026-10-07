# UFA multiplayer operations

## Before starting

1. Supply the real `data/players.json` and `data/managers.json` described in `data/README.md`. **They are currently missing; startup intentionally fails.**
2. Use Node 24 LTS (minimum 22.9). Run `npm ci`.
3. Copy `.env.example` to `.env` locally, or configure those variables in Render. Set `REDIS_URL` to your Redis-compatible service. No in-memory fallback exists.
4. Run `npm run check:data`, `npm test`, then `npm start`.

`GET /health` reports readiness, dataset counts, storage readiness and `RENDER_GIT_COMMIT`. It returns 503 during storage failure/recovery. Startup exits nonzero for missing/invalid data, invalid configuration, or unavailable Redis. No secrets are included in health responses or room snapshots.

## Persistence and recovery

`roomStore.js` stores versioned JSON under `ufa:v1:room:<CODE>`. Each accepted user action/create/join/resume renews a four-hour expiry. Timer checkpoints do **not** renew expiry: an abandoned auction disappears after four hours without interaction. Configure 2–6 hours with `ROOM_TTL_SECONDS`.

Per-room mutation queues serialize local actions. Redis Lua compare-and-set rejects stale writes and deletes, including overlap during deployment. Only persistable data is stored: teams, purses, draft pool, lot, bid, passes, phase, clock deadline/remaining milliseconds and private authentication hashes. Runtime timer/socket objects are never stored.

Run **one web-service instance**. On startup the new process takes ownership of persisted rooms; the old process stops serving those rooms when it sees the new owner. This is not a horizontally scaled Socket.IO deployment. Multiple permanent workers would need a Socket.IO adapter and a distributed ownership/leader protocol.

After a process restart, a live room returns **paused at its last one-second checkpoint**, preserving the lot, highest bid, passes and purchases. No lots are sold while the process is down. The host resumes after clubs reconnect. A Redis interruption similarly blocks mutations and triggers a paused recovery when storage returns. A write whose acknowledgement was lost may have committed; session retries and action request IDs prevent duplicate processing.

The twelve-second hammer resets after a bid. Three-second lot reveals and five-second manager/midfielder phase ads are server-synchronized; bidding waits for the transition to finish. This corrects the previous behavior where the clock ran behind a client-only ad. Draft order, pool sizing, bid slabs and role quotas remain unchanged.

## Sessions and disconnects

- The server assigns a UUID team ID. The browser creates a random 256-bit enrollment/reconnect secret **before** sending create/join, so a lost acknowledgement can be recovered. Only its SHA-256 hash is stored on the server. The token is never broadcast.
- The browser saves `{roomCode, teamId, sessionToken}` in **sessionStorage**, scoped to the backend URL and tab. Refresh and temporary network loss resume the same club. A pending enrollment can resume using its secret before its team ID has been acknowledged.
- Opening the same credentials twice moves control to the newest socket and disconnects the old one. Different tabs can join as different clubs. Closing the browser tab may discard its session; clearing storage loses access. Room passwords cannot recover host identity.
- Disconnect marks the club offline immediately. Lobby guests get **45 seconds** to return before removal. The host remains until room expiry; host identity never transfers automatically.
- Live clubs retain their squads, purse, bid and session when offline. They are not automatically passed or deleted. The hammer continues during a temporary drop; if all clubs go offline it pauses immediately. If the host remains offline for 45 seconds it pauses until the host resumes.
- Kicking is lobby-only: deleting a live club would invalidate bids and purchases. The host can still pause or close a live room.

## Request and security boundaries

Create, join, resume and all game actions use `{ok:true,...}` or `{ok:false,error,message}` acknowledgements. The client disables pending/offline actions and shows connection errors without alert loops. Actions carry a UUID request ID and bids/passes carry a lot index; each team remembers its last 32 accepted action IDs. Room codes normalize to uppercase; passwords remain case-sensitive. Budgets, capacities, categories and lengths are validated on the server.

Room and team snapshots are whitelisted. Room passwords use salted scrypt hashes; session secrets use SHA-256. Membership and host authorization are checked for each action. Authentication requests are limited to 30/minute per connection, and actions to 40/second per club (or connection before enrollment). Limits never combine unrelated users behind Render's shared proxy. These are basic flood guards, not protection against attackers continually opening new connections; broader IP-based controls require verified proxy configuration. Socket.IO accepts polling plus WebSocket and validates browser origins using the exact `ALLOWED_ORIGINS` list. Club names are escaped at HTML boundaries and activity messages use textContent. Only public files/assets are served; backend source, env files and datasets are not static assets.

`client-config.js` is the sole browser backend setting. The known GitHub Pages host uses `https://ufa-test-v2.onrender.com`; the Render app and local development use their own origin. Change that one file if the public backend URL changes, and add any new frontend origin to `ALLOWED_ORIGINS`.

## Existing Render service

Audited service: `ufa-test-v2`, Singapore, repository `Niladripan23/UFA`, branch `main`, one free web instance. At audit time it was still running commit `2fb946964f5ce4a074efd26a6fb5cd8dd84a2fe6`; there was no Key Value instance. Auto-deploy was enabled but the latest GitHub commits had not been deployed.

After the real data is committed:

1. Create a **durable** Redis-compatible service in Singapore (Render Key Value paid plan with **Journal + Snapshot**, `noeviction`, internal-only access recommended). Set the web service's `REDIS_URL` to its internal URL. No paid resource is provisioned by this change.
2. Set `ALLOWED_ORIGINS=https://ufa-test-v2.onrender.com,https://niladripan23.github.io`; set `ROOM_TTL_SECONDS=14400`. Render supplies `PORT` and `RENDER_GIT_COMMIT`. Use Node 24.
3. Set build command `npm ci && npm run check:data`, start command `npm start`, health check `/health`, instance count **1**.
4. Use **Manual Deploy → Deploy latest commit**, then compare `/health`'s `commit` with GitHub main. A successful old deployment is not verification of the new code.
5. Verify create/join/bid on independent devices and both polling/WebSocket paths. Do not repeatedly redeploy while datasets or Redis are absent.

Render's free Key Value plan loses its own data on restart; it cannot provide durable room recovery. Paid Journal + Snapshot can still lose approximately the last second of writes during datastore failure. The free **web** plan can cold-start after sleeping; clients retry, but always-on latency requires an appropriate paid web plan. No system can restore expired rooms or data lost by the datastore itself. See [Render Key Value persistence](https://render.com/docs/key-value#data-persistence).

## Tests

`npm test` runs game-rule, validation and snapshot-security tests without real game data. Minimal labeled test objects are injected only through the test entry point and are never production datasets.

Run `TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:multiplayer` on POSIX, or set `$env:TEST_REDIS_URL` then run the command in PowerShell. It uses a unique Redis key prefix, starts a real Node child process and independent Socket.IO clients, kills/restarts the Node process, and removes only its own test rooms afterward. Do not point tests at a public production room namespace.

Coverage includes create/join/live counts, polling/WebSocket, bid/pass broadcasts, simultaneous bids, duplicate requests/sessions, refresh/drop resume, host recovery, wrong credentials/codes, unauthorized actions, lobby grace cleanup, private route protection, CORS, TTL and stale-write rejection. Physical multi-network phone testing and live Render verification require the missing real datasets and configured durable Redis.

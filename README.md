# ui3-push-service

A static relay site, served at https://ui3-push.bp2008.org/, that lets [UI3](https://github.com/bp2008/ui3) receive Web Push notifications from Blue Iris when UI3 itself is not served from a secure context (HTTPS with a trusted certificate).

**Its origin is permanent.** Push subscriptions belong to the origin that created them, so moving this site to a different domain later breaks every subscription made here. Settle on the final domain before the feature goes live.

## How it works

1. UI3 fetches the Blue Iris server's VAPID public key, then opens `index.html` as a popup. Everything is passed in the URL fragment, so the web host never sees it:
   `index.html#k=<vapidPublicKey>&r=<ui3Url>&n=<serverName>&o=<nonce>`
2. The user clicks **Enable notifications**. The page registers `sw.js` with a scope derived from the server key (`s/<sha256(key)[0..8] as hex>/`), requests notification permission, and subscribes.
3. The subscription (`{endpoint, expirationTime, keys: {p256dh, auth}}`) goes back to UI3:
   - Popup: `window.opener.postMessage(result, <origin of r>)`, then close after UI3 acknowledges.
   - Otherwise: `location.replace(r + "#ui3push=" + base64url(JSON(result)))`.
4. UI3 gives the subscription to Blue Iris, or to the prototype push server.
5. Blue Iris sends encrypted pushes directly to the browser's push service. `sw.js` shows them, and opens the payload's `url` on click.

The site stores nothing and has no server-side code. Payloads are end-to-end encrypted between Blue Iris and the browser, and only the service worker here can read them. Whoever controls this repository's `sw.js` can therefore read future notification payloads. Protect the repo accordingly: 2FA, branch protection, and few collaborators.

## Result message

```json
{ "type": "ui3push-relay-result", "v": 1, "nonce": "...", "ok": true, "subscription": { "endpoint": "...", "expirationTime": null, "keys": { "p256dh": "...", "auth": "..." } } }
{ "type": "ui3push-relay-result", "v": 1, "nonce": "...", "ok": false, "error": "cancelled|unsupported|permission-denied|permission-dismissed|failed", "message": "..." }
```

UI3 acknowledges a postMessage result with `{ "type": "ui3push-relay-ack", "nonce": "..." }`.

## Push payload (v1)

JSON, at most about 3 KB:

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Defaults to "Blue Iris" |
| `body` | string | |
| `tag` | string | Notifications with the same tag replace each other |
| `renotify` | bool | Default true when `tag` is set |
| `url` | string | http(s) URL opened on click |
| `ts` | number | Event time, ms since epoch |
| `icon`, `image` | string | https URL or small `data:image/...;base64,` |
| `requireInteraction`, `silent` | bool | |

## Local testing

`127.0.0.1` and `localhost` count as secure contexts, so this folder works when served locally (for example at `http://127.0.0.1:81/dev/ui3-push-service/`). Point UI3's "Relay site URL" prototype setting at it.

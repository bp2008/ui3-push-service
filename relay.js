// UI3 Push Notification Relay (prototype)
//
// UI3 opens this page with these URL fragment parameters (a fragment is never sent to the web server):
//   k: The Blue Iris server's VAPID public key, base64url encoded (65-byte uncompressed P-256 point).
//   r: The UI3 URL to return the result to.  http: or https:
//   n: A display name for the Blue Iris server (optional).
//   o: A nonce chosen by UI3, echoed back so UI3 can recognize the result.
//
// The page subscribes for push notifications using a service worker scoped to this Blue Iris server's
// VAPID key, then returns the subscription to UI3.  If UI3 opened this page as a popup, the result is
// sent with postMessage to the opener (restricted to the return URL's origin).  Otherwise, or if UI3
// does not acknowledge the message, the page navigates to the return URL with the result in its fragment.
"use strict";
(function ()
{
	var PROTOCOL_VERSION = 1;
	var params = parseFragment(location.hash);
	// Remove the parameters from the address bar so they don't linger in history or bookmarks.
	try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { }

	var $ = function (id) { return document.getElementById(id); };
	var views = ["viewLoading", "viewRequest", "viewBusy", "viewResult", "viewInvalid"];
	function show(viewId)
	{
		for (var i = 0; i < views.length; i++)
			$(views[i]).hidden = views[i] !== viewId;
	}

	var returnUrl = parseReturnUrl(params.r);
	var keyBytes = base64UrlDecode(params.k);
	var nonce = typeof params.o === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(params.o) ? params.o : null;
	var serverName = typeof params.n === "string" ? params.n.substring(0, 100) : "";

	if (!returnUrl || !keyBytes || keyBytes.length !== 65 || keyBytes[0] !== 4 || !nonce)
	{
		var problems = [];
		if (!returnUrl) problems.push("return URL");
		if (!keyBytes || keyBytes.length !== 65 || keyBytes[0] !== 4) problems.push("server key");
		if (!nonce) problems.push("request ID");
		$("invalidDetail").textContent = "Missing or invalid: " + problems.join(", ") + ".";
		show("viewInvalid");
		return;
	}

	$("targetName").textContent = serverName || "Blue Iris";
	$("targetHost").textContent = returnUrl.origin + returnUrl.pathname;
	$("relayOrigin").textContent = location.host;
	$("insecureReason").hidden = returnUrl.protocol === "https:"; // UI3 only uses the relay from an HTTPS address when a setting forces it.

	var unsupportedReason = getUnsupportedReason();
	if (unsupportedReason)
	{
		finishWithError("unsupported", unsupportedReason);
		return;
	}
	if (Notification.permission === "denied")
	{
		finishWithError("permission-denied", "Notifications are blocked for " + location.host + " in this browser.  To fix this, allow notifications for this site in your browser's site settings, then try again from UI3.");
		return;
	}

	show("viewRequest");
	$("btnEnable").addEventListener("click", onEnableClick);
	$("btnCancel").addEventListener("click", function ()
	{
		finish({ ok: false, error: "cancelled", message: "Cancelled." });
	});

	function onEnableClick()
	{
		// Request permission before doing anything asynchronous, so the browser still considers it a response to the click.
		var permissionPromise = requestPermission();
		show("viewBusy");
		$("busyText").textContent = "Waiting for notification permission…";
		permissionPromise
			.then(function (permission)
			{
				if (permission !== "granted")
					throw new RelayError(permission === "denied" ? "permission-denied" : "permission-dismissed", "Notification permission was not granted.");
				$("busyText").textContent = "Subscribing…";
				return getScopeForKey(keyBytes);
			})
			.then(function (scope)
			{
				return navigator.serviceWorker.register("sw.js", { scope: scope });
			})
			.then(waitForActive)
			.then(function (registration)
			{
				return getOrCreateSubscription(registration, keyBytes);
			})
			.then(function (subscription)
			{
				finish({ ok: true, subscription: subscription.toJSON() });
			})
			.catch(function (err)
			{
				console.error(err);
				if (err instanceof RelayError)
					finishWithError(err.code, err.message);
				else
					finishWithError("failed", "Unable to subscribe: " + (err && err.message ? err.message : String(err)));
			});
	}

	function finishWithError(code, message)
	{
		finish({ ok: false, error: code, message: message });
	}

	/** Shows the result, then delivers it to UI3. */
	function finish(result)
	{
		result.type = "ui3push-relay-result";
		result.v = PROTOCOL_VERSION;
		result.nonce = nonce;

		show("viewResult");
		$("resultText").className = result.ok ? "ok" : "error";
		$("resultText").textContent = result.ok ? "Notifications are enabled.  Returning to UI3…" : result.message;
		$("btnReturn").onclick = function () { redirectBack(result); };

		if (window.opener && !window.opener.closed)
		{
			var acked = false;
			window.addEventListener("message", function (e)
			{
				if (e.origin === returnUrl.origin && e.data && e.data.type === "ui3push-relay-ack" && e.data.nonce === nonce)
				{
					acked = true;
					if (result.ok || result.error === "cancelled")
					{
						if (result.ok)
							$("resultText").textContent = "Notifications are enabled.  You can close this window.";
						$("resultButtons").hidden = true;
						window.close();
					}
				}
			});
			try
			{
				window.opener.postMessage(result, returnUrl.origin);
			}
			catch (ex)
			{
				console.error(ex);
			}
			// Failures stay on screen so the user can read them; successes fall back to a redirect if UI3 doesn't answer.
			if (result.ok)
				setTimeout(function () { if (!acked) redirectBack(result); }, 3000);
		}
		else if (result.ok)
			redirectBack(result);
	}

	function redirectBack(result)
	{
		var url = returnUrl.href.replace(/#.*$/, "");
		location.replace(url + "#ui3push=" + base64UrlEncode(new TextEncoder().encode(JSON.stringify(result))));
	}

	function getUnsupportedReason()
	{
		if (!window.isSecureContext)
			return "This relay page is not running in a secure context, so push notifications are unavailable.";
		if (!("serviceWorker" in navigator))
			return "This browser does not provide service workers here.  They may be disabled, for example in a private browsing window.";
		if (!("PushManager" in window))
			return "This browser does not support push notifications.";
		if (!("Notification" in window))
			return "This browser does not support notifications.";
		if (!window.crypto || !window.crypto.subtle)
			return "This browser does not support the Web Crypto API.";
		return null;
	}

	function requestPermission()
	{
		return new Promise(function (resolve)
		{
			// Older Safari versions only support the callback form.
			var p = Notification.requestPermission(resolve);
			if (p && typeof p.then === "function")
				p.then(resolve);
		});
	}

	/** Each Blue Iris server gets its own service worker scope, because a scope can hold only one push subscription and it is bound to one server key. */
	function getScopeForKey(keyBytes)
	{
		return crypto.subtle.digest("SHA-256", keyBytes).then(function (hash)
		{
			var bytes = new Uint8Array(hash);
			var hex = "";
			for (var i = 0; i < 8; i++)
				hex += ("0" + bytes[i].toString(16)).slice(-2);
			return "s/" + hex + "/";
		});
	}

	function waitForActive(registration)
	{
		if (registration.active)
			return Promise.resolve(registration);
		return new Promise(function (resolve, reject)
		{
			var worker = registration.installing || registration.waiting;
			if (!worker)
				return reject(new Error("The service worker registration has no worker."));
			worker.addEventListener("statechange", function ()
			{
				if (worker.state === "activated")
					resolve(registration);
				else if (worker.state === "redundant")
					reject(new Error("The service worker failed to install."));
			});
		});
	}

	function getOrCreateSubscription(registration, keyBytes)
	{
		return registration.pushManager.getSubscription().then(function (existing)
		{
			if (existing && existing.options && bytesEqual(existing.options.applicationServerKey, keyBytes))
				return existing;
			var cleanup = existing ? existing.unsubscribe() : Promise.resolve();
			return cleanup.then(function ()
			{
				return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
			});
		});
	}

	function RelayError(code, message)
	{
		this.code = code;
		this.message = message;
	}

	function parseFragment(hash)
	{
		var out = {};
		hash.replace(/^#/, "").split("&").forEach(function (part)
		{
			var idx = part.indexOf("=");
			if (idx > 0)
			{
				try { out[decodeURIComponent(part.substring(0, idx))] = decodeURIComponent(part.substring(idx + 1)); }
				catch (e) { }
			}
		});
		return out;
	}

	function parseReturnUrl(str)
	{
		if (typeof str !== "string")
			return null;
		try
		{
			var url = new URL(str);
			if (url.protocol !== "http:" && url.protocol !== "https:")
				return null;
			return url;
		}
		catch (e)
		{
			return null;
		}
	}

	function base64UrlDecode(str)
	{
		if (typeof str !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(str))
			return null;
		try
		{
			var b64 = str.replace(/-/g, "+").replace(/_/g, "/");
			while (b64.length % 4)
				b64 += "=";
			var bin = atob(b64);
			var bytes = new Uint8Array(bin.length);
			for (var i = 0; i < bin.length; i++)
				bytes[i] = bin.charCodeAt(i);
			return bytes;
		}
		catch (e)
		{
			return null;
		}
	}

	function base64UrlEncode(bytes)
	{
		var bin = "";
		for (var i = 0; i < bytes.length; i++)
			bin += String.fromCharCode(bytes[i]);
		return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	function bytesEqual(a, b)
	{
		if (!a || !b)
			return false;
		a = new Uint8Array(a);
		b = new Uint8Array(b);
		if (a.length !== b.length)
			return false;
		for (var i = 0; i < a.length; i++)
			if (a[i] !== b[i])
				return false;
		return true;
	}
})();

// UI3 Push Notification Relay service worker (prototype)
//
// Shows notifications pushed by a Blue Iris server and opens UI3 when one is clicked.
// The relay page registers this script once per Blue Iris server, each with its own scope.
//
// Payload (JSON, encrypted end-to-end by Blue Iris per RFC 8291, so only this browser can read it):
//   title, body, tag, url, ts, icon, image, requireInteraction, silent, renotify
// "url" is the page to open when the notification is clicked (normally a UI3 URL).
"use strict";

self.addEventListener("install", function (event)
{
	self.skipWaiting();
});

self.addEventListener("push", function (event)
{
	event.waitUntil(showPushNotification(event));
});

self.addEventListener("notificationclick", function (event)
{
	event.notification.close();
	var url = event.notification.data && event.notification.data.url;
	if (url)
		event.waitUntil(self.clients.openWindow(url));
});

function showPushNotification(event)
{
	var data = {};
	if (event.data)
	{
		try { data = event.data.json() || {}; }
		catch (e) { data = { body: event.data.text() }; }
	}
	var tag = str(data.tag);
	var options = {
		body: str(data.body),
		icon: safeUrl(data.icon, true) || "icon-168.png",
		timestamp: typeof data.ts === "number" ? data.ts : Date.now(),
		requireInteraction: !!data.requireInteraction,
		silent: !!data.silent,
		data: { url: safeUrl(data.url, false) }
	};
	var image = safeUrl(data.image, true);
	if (image)
		options.image = image;
	if (tag)
	{
		options.tag = tag;
		options.renotify = data.renotify !== false;
	}
	return self.registration.showNotification(str(data.title) || "Blue Iris", options);
}

function str(value)
{
	return typeof value === "string" ? value : "";
}

/** Returns the URL if it is http(s), or (when allowDataImage) a data:image URL.  Otherwise returns undefined. */
function safeUrl(value, allowDataImage)
{
	if (typeof value !== "string" || !value)
		return undefined;
	if (allowDataImage && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(value))
		return value;
	try
	{
		var url = new URL(value);
		if (url.protocol === "http:" || url.protocol === "https:")
			return url.href;
	}
	catch (e) { }
	return undefined;
}

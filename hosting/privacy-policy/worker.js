// Cutlyra — static privacy-policy host.
//
// This Worker serves nothing of its own: it only handles the one redirect the
// site needs and hands every other request straight to the static asset
// binding. There is no database, no auth, no server-side logic and no
// outbound network call anywhere in it, which is what keeps Cutlyra's
// "fully offline / no telemetry" claim honest for the source that ships in
// the app.
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		// Keep one canonical address for the policy. Play Console stores a
		// single absolute URL, so a bare `/` must not be a 404.
		if (url.pathname === "/" || url.pathname === "/index.html") {
			return Response.redirect(new URL("/privacy-policy.html", url.origin), 301);
		}
		return env.ASSETS.fetch(request);
	},
};

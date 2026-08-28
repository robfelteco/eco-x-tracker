import { auth } from "@/auth";

// Everything is behind Google sign-in except the paths in the matcher's
// negative lookahead below.
//
// This is Next 16's "proxy" file convention. It was `middleware.ts` until the
// rename; under Turbopack dev the deprecated name failed outright with
// "Cannot find the middleware module", so the rename is load-bearing, not
// cosmetic.
//
// /api/sync is deliberately NOT protected here: Vercel Cron calls it with no
// user session, and it already authenticates itself (CRON_SECRET bearer token
// or the x-vercel-cron header — see app/api/sync/route.ts). Putting it behind
// the session check would silently kill the 05:00 daily sync.
export default auth((req) => {
  if (!req.auth) {
    const url = new URL("/api/auth/signin", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: [
    "/((?!api/auth|api/sync|denied|_next/static|_next/image|favicon.ico|fonts|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)$).*)",
  ],
};

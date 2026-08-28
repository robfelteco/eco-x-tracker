import { auth } from "@/auth";

// Everything is behind Google sign-in except the paths in the matcher's
// negative lookahead below.
//
// This is Next 16's "proxy" file convention. It was `middleware.ts` until the
// rename; under Turbopack dev the deprecated name failed outright with
// "Cannot find the middleware module", so the rename is load-bearing, not
// cosmetic.
//
// /api/sync and /api/sweep are deliberately NOT protected here: Vercel Cron
// calls them with no user session, and both authenticate themselves (CRON_SECRET
// bearer token or the x-vercel-cron header). Putting them behind the session
// check silently kills the crons, and it fails in a way that looks like success:
// the cron gets a 302 to the sign-in page and Vercel records a 2xx. /api/sweep
// hit exactly that on its first production call, which is why it is listed here.
export default auth((req) => {
  if (!req.auth) {
    const url = new URL("/api/auth/signin", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
    return Response.redirect(url);
  }
});

export const config = {
  matcher: [
    "/((?!api/auth|api/sync|api/sweep|denied|_next/static|_next/image|favicon.ico|fonts|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|woff2?)$).*)",
  ],
};

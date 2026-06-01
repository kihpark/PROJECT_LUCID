import { NextResponse, type NextRequest } from 'next/server';

// /pending/* requires a JWT (mirrored to a cookie by lib/auth.setToken).
// Unauthenticated requests get bounced to /login.
//
// /login itself is not part of this PR (PR-4A-2 lands it). For now,
// the middleware redirects to /?login=1 so the homepage can show a
// banner — without crashing on an unknown route.
export function middleware(request: NextRequest) {
  const token = request.cookies.get('lucid_jwt')?.value;
  if (!token) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = 'login=1';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/pending/:path*'],
};

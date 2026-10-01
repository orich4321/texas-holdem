# Google sign-in setup

The application uses Supabase Auth for Google's OAuth/PKCE exchange. The game
service then verifies the Supabase user and issues its own opaque, hashed,
30-day account session. Google and Supabase access tokens are not kept in the
application database or browser after the callback.

1. In Google Cloud, create an **OAuth client ID** of type **Web application**.
   Under **Authorized redirect URIs**, add the Supabase project's callback:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
2. In Supabase Dashboard → Authentication → Providers → Google, enable Google
   and enter the client ID and secret from Google Cloud. Configure the consent
   screen/audience so the intended friends can sign in.
3. In Supabase Dashboard → Authentication → URL Configuration, add
   `https://texas-holdem-play.vercel.app/server/auth/google/callback` to
   **Redirect URLs**. For local development, also add
   `http://localhost:3001/auth/google/callback`.
4. In the Vercel project, set these game-service environment variables for
   Production (and Preview if desired):

   - `SUPABASE_URL=https://<project-ref>.supabase.co`
   - `SUPABASE_PUBLISHABLE_KEY=<the project's publishable key>`
   - `PUBLIC_APP_ORIGIN=https://texas-holdem-play.vercel.app`
   - `GOOGLE_AUTH_ENABLED=true` (only after the Google provider is enabled and verified)

   Set the same values in local `.env`, with `PUBLIC_APP_ORIGIN=http://localhost:3000`.
   Never place the Google client secret, Supabase service-role key, or database
   password in a `NEXT_PUBLIC_` variable or this repository.

5. Redeploy the Vercel project after setting the variables. `/server/auth/me`
   should then return `{"enabled":true,"profile":null}` in a fresh browser.
   The first login sends the player to `/profile` to choose a name and optional
   photo. Returning logins reuse that saved profile and account session.

The optional history and hand-replay features are intentionally not part of
this rollout. Existing anonymous room sessions remain usable; when a player
with a valid legacy room cookie signs into Google, that seat can be linked to
the account without creating another player.

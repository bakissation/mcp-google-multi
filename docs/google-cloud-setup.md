# Google Cloud setup (one-time, ~2 minutes)

The server signs in to Google **as you**, through an OAuth app that you own. Creating it is free and needs no billing account. Back to the [README](../README.md).

1. Open the [Google Cloud Console](https://console.cloud.google.com) and sign in with any Google account. Create a project (top bar → project picker → **New project**) or pick an existing one.
2. Enable the APIs you'll use: **APIs & Services → Library**, search and enable Gmail, Google Drive, Google Calendar, Google Sheets, Google Docs, People, Search Console, Tasks, Google Meet, and Google Workspace Events. (Enable Slides / Forms / Chat / Admin SDK / Classroom / Vault / the two Google Analytics APIs (Data + Admin) / etc. later if you turn on those [bundles](./configuration.md#optional-scope-bundles).) You don't have to get this list exact now — once the server is running, `mcp-google-multi doctor` flags any API you still need to switch on, with a direct link to enable it.
3. Create the OAuth client: **APIs & Services → Credentials → Create Credentials → OAuth client ID**. If asked to configure the consent screen first: choose **External**, fill in the app name and your email, and add your own Google account(s) as **Test users** — nothing needs to be verified for personal use.
4. Choose application type **Desktop app**, any name. No redirect URI needs registering: Desktop clients accept loopback redirects on any `http://localhost:<port>`, and the auth flow binds an ephemeral port each run.
5. Copy the **Client ID** and **Client Secret** — these become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your configuration.

Because the app is yours and unverified, Google shows an "unverified app" warning during sign-in — click **Advanced → Continue**. That's expected: you are the only user of your own OAuth app.

## Once it works: set Publishing status to "In production"

While the consent screen's Publishing status is **Testing**, Google expires refresh tokens after **7 days** for the scopes this server uses — you would have to re-auth every account weekly. When your setup works, open [Audience](https://console.cloud.google.com/auth/audience) and set Publishing status to **In production**. The unverified-app warning stays (still **Advanced → Continue**), no verification review is required for personal use, and tokens stop expiring. This applies to every bundle, Analytics included — if a working account suddenly fails with `reauth_required` after a week, this is why.

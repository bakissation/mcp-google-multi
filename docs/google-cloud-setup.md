# Google Cloud setup (one-time, ~2 minutes)

The server signs in to Google **as you**, through an OAuth app that you own. Creating it is free and needs no billing account. Back to the [README](../README.md).

1. Open the [Google Cloud Console](https://console.cloud.google.com) and sign in with any Google account. Create a project (top bar → project picker → **New project**) or pick an existing one.
2. Enable the APIs you'll use: **APIs & Services → Library**, search and enable Gmail, Google Drive, Google Calendar, Google Sheets, Google Docs, People, Search Console, Tasks, and Google Meet. (Enable Slides / Forms / Chat / Admin SDK / Classroom / Vault / etc. later if you turn on those [bundles](./configuration.md#optional-scope-bundles).)
3. Create the OAuth client: **APIs & Services → Credentials → Create Credentials → OAuth client ID**. If asked to configure the consent screen first: choose **External**, fill in the app name and your email, and add your own Google account(s) as **Test users** — nothing needs to be verified for personal use.
4. Choose application type **Desktop app**, any name. After creating it, add the redirect URI `http://localhost:4242/oauth2callback` if the console offers the field (Desktop clients often accept loopback redirects automatically).
5. Copy the **Client ID** and **Client Secret** — these become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your configuration.

Because the app is yours and unverified, Google shows an "unverified app" warning during sign-in — click **Advanced → Continue**. That's expected: you are the only user of your own OAuth app.

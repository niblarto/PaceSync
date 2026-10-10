# PaceSync Android

Native companion app for [PaceSync](../README.md) — Summary, Schedule and
Routes (GPS map) screens, plus push notifications (replacing ntfy) via
Firebase Cloud Messaging. Sideloaded, not published to the Play Store.

This is a **separate Gradle project**, built independently of the Next.js
app's `deploy.py` — that script never touches this directory.

## Setup

1. **JDK 17** is required (already present if you've built the main app's
   deploy tooling). Confirm with `java -version`.
2. **Firebase project** (free tier, Spark plan — no billing needed for FCM):
   - Create a project at [console.firebase.google.com](https://console.firebase.google.com).
   - Add an Android app with package name `com.pacesync.app`.
   - Download `google-services.json` and place it at `android/app/google-services.json`
     (gitignored — it's per-developer/per-Firebase-project, not committed).
   - On the backend (`E:\Code\Running`), generate a service-account key
     (Project Settings → Service Accounts → Generate new private key) and set
     `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env.local` to its full JSON content
     as a single-line string — this is what `lib/push.ts` uses to actually
     *send* pushes; the `google-services.json` above is only what the
     *app* uses to *receive* them. Both come from the same Firebase project.
3. **Mint a mobile API token**: on the web app, go to Settings → Notifications
   → "Mobile App", enter your password (+ TOTP if 2FA is on), and copy the
   generated token.
4. **Build**: `./gradlew assembleDebug` (from this `android/` directory).
   The APK lands at `app/build/outputs/apk/debug/app-debug.apk`.
5. **Install**: `adb install app/build/outputs/apk/debug/app-debug.apk`, or
   transfer the APK to the phone and tap it (Android will prompt to allow
   "install unknown apps" for whichever app you used to open it).
6. **Sign in**: open the app → Settings tab → paste the token from step 3 →
   "Save token & register for push". Grant the notification permission when
   prompted (Android 13+).

## Project layout

```
android/app/src/main/java/com/pacesync/app/
  MainActivity.kt / PaceSyncApp.kt   — single Activity, Compose NavHost (4 tabs)
  network/                           — Retrofit + OkHttp + the bearer-token interceptor
  data/                              — EncryptedSharedPreferences token store, manual DI container
  ui/{summary,schedule,routes,settings}/ — the 4 screens
  push/                              — FirebaseMessagingService + Notification Channels
```

## Notes

- **Backend URL** is baked in at build time (`BuildConfig.API_BASE_URL`, see
  `app/build.gradle.kts`) pointing at the real deployed PaceSync instance —
  this app only ever talks to one backend, so there's no in-app server
  picker.
- **Maps** use osmdroid (OpenStreetMap), not Google Maps — no API key or
  billing setup required.
- **Auth**: the app never logs in directly — the bearer token is generated
  on the *web* Settings page (which re-verifies password+TOTP) and pasted in.
  This keeps credential entry on the already-trusted web flow rather than
  duplicating password/TOTP UI natively.

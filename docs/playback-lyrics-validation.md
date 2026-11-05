# Playback and lyrics validation

Automated: `node --test tests/*.test.cjs`, `npm run typecheck`.
Tests cover LRC ordering/multiple timestamps, stable player hosts, cancelled startup,
retry creation, and resetting rejected API loads.

Deployment smoke test (requires YouTube, LRCLIB, and configured database):
1. Open a room on desktop and mobile, first empty, then queue a track.
2. Verify playback starts muted without refreshing; tap for sound on each device.
3. Pause/resume, seek, skip, mute and change volume. Check both devices stay aligned
   and skipping does not unmute a muted listener.
4. Clear the room during startup, queue another track, and navigate away/back.
   Verify there are no orphan players or stale startup errors.
5. Block the YouTube API script, wait for failure, unblock, and select Try again.
6. Open Lyrics: it should cover the viewport, trap focus, close with Escape/Close,
   restore focus, and keep playback running. Test mobile scrolling/orientation.
7. On a track with synced lyrics, verify highlighting follows pause, seek and skip.
   Check plain lyrics, instrumental, missing lyrics, and offline/provider failure.

Lyrics use LRCLIB's exact track/artist lookup through a same-origin server route.
YouTube titles/channel names may not match catalog metadata; these show the fallback
rather than potentially incorrect search results. No audio-recognition matching is used.

Sandbox limits: outbound YouTube/LRCLIB/Google Fonts are unavailable. Production build
is blocked fetching the existing next/font Google fonts. Live provider coverage,
autoplay policies and two-device synchronization require the deployment smoke test.

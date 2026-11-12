# Further bug audit — fixed 2026-11-12

What this repo does: Rooftop shares encrypted files and chat between browsers and native hosts on a local network. This review assumes one host and a handful of devices, including interrupted connections, session resets, and accidental duplicate launches.

The browser history, receive storage, premature download acknowledgement, and manual upload retry changes were verified before this review. All five findings below are now fixed in the working tree. Nothing has been committed or pushed by the agent.

## Fixed findings

1. **Private host files become public after a restart (P1).** [Inbox.java](../src/rooftop/model/Inbox.java#L82)
   - **What this is:** The inbox reloads saved files when the host starts.
   - **Original problem:** It assigns `EVERYONE` to every visible file on disk, discarding the original recipient. An isolated check stored a host-only file, reopened the inbox, and confirmed that `visibleTo("stranger")` changed from false to true.
   - **Fix applied:** Files restored from disk are now host-only. No recipient metadata is guessed or restored as public.
   - **Original consequence:** Someone joining a later session can download files previously sent privately to the host.

2. **Ending a session does not stop an upload already writing (P1).** [Inbox.java](../src/rooftop/model/Inbox.java#L42), [Rooftop.java](../src/rooftop/Rooftop.java#L129)
   - **What this is:** File writes run outside the inbox monitor; session reset clears completed items.
   - **Original problem:** A paused upload can resume and publish its file after `newSession()` returns. A latch-controlled isolated check reproduced this with `store()`. The HTTP route authenticates before receiving the body and does not recheck the session before publishing it.
   - **Fix applied:** HTTP and native transfer callers capture the storage generation before authentication. Normal, resumable, and sealed writes reject stale completion and clean partial files. History publication is guarded too. Browser uploads carry their original session so automatic retries cannot restart them in a new session.
   - **Original consequence:** Files from a disconnected session can appear in the new session, including files shared with everyone.

3. **Starting a second host deletes the first host's relay files (P1).** [SealedBox.java](../src/rooftop/model/SealedBox.java#L67), [Rooftop.java](../src/rooftop/Rooftop.java#L41)
   - **What this is:** Every host process for the same OS user uses the same temporary relay directory.
   - **Original problem:** Constructing `SealedBox` wipes that directory before the new process tries to bind its listening ports. An isolated check created a waiting file, constructed a second box against the same directory, and confirmed the first box no longer offered the file.
   - **Fix applied:** Rooftop claims an OS file lock before initializing either storage directory. Duplicate launches and duplicate construction in one JVM fail without touching existing files; a failed constructor releases its lock.
   - **Original consequence:** Accidentally launching Rooftop twice silently destroys pending transfers even though the second launch fails to start.

4. **Some system locales generate unusable PINs (P2).** [PinGuard.java](../src/rooftop/security/PinGuard.java#L27)
   - **What this is:** The host formats a six-digit PIN using the system's default locale.
   - **Original problem:** With `ar-EG`, `String.format("%06d", ...)` produces non-ASCII digits. The browser's PIN form accepts only ASCII digits. An isolated check reproduced the mismatch.
   - **Fix applied:** PIN formatting uses `Locale.ROOT`; an Arabic-locale regression verifies ASCII digits.
   - **Original consequence:** Users on affected systems cannot enter the displayed PIN manually.

5. **Cancel does nothing during the announcement step (P2).** [app.js](../web/app.js#L2271)
   - **What this is:** New jobs wait in `announcing` while the browser sends the incoming-transfer notice.
   - **Original problem:** `cancelJob()` handles only `waiting` and `sending`. A direct check confirmed that cancelling an announcing job changes neither its state nor its cancellation flag; after the notice completes, `upload()` changes it to `waiting` and sends it.
   - **Fix applied:** Announcing jobs are shown immediately and can be cancelled. Announcement completion only promotes jobs still announcing; it cannot requeue a cancelled job.
   - **Original consequence:** A transfer can start after the user has clicked Cancel, particularly on a slow or unreliable network.

Verdict: All five reported bugs are fixed, with regression checks.

Validation: Java SelfTest exercises restart privacy, Arabic PIN formatting, duplicate ownership in one JVM and a separate process, paused normal/resumable/sealed uploads across reset, stale HTTP retries, and successful new-session HTTP uploads. The focused JavaScript check exercises cancellation while an announcement is blocked, as well as streaming, resume, and memory limits. Tests use temporary storage and do not reset the running user's session.

Not checked: Physical Android/iOS behavior, Android packaging, Windows/macOS behavior, a cryptographic proof, or an exhaustive review of rendering, discovery, and every chat path. Android save and service code was inspected but not executed. Reset behavior was tested through isolated storage and HTTP-route checks; the live host was not reset or restarted. The existing APK needs rebuilding to include these source changes.

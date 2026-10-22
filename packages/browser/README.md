# @skillforge/browser — Real-Human Browser

The browser layer, used only when a task truly needs the web. It drives
Chromium the way a person does, because behavior-scored checks (and
plain reliability) reward exactly that.

## The rule

The cursor physically travels and clicks in real time. There is no
teleporting the mouse, and no acting through the DOM: no
`element.click()`, no assigning field values, no reaching into the page
to make things happen. Actions go through Playwright's real mouse and
keyboard APIs; reading page state (a bounding box, a result value) is
observation, which is what eyes do.

## What's here

- `generateMousePath(from, to, opts?)` (`src/path.ts`) — a cubic
  Bezier trail from the current position to a point just past the
  target, with randomized sideways control-point bows, an ease-in-out
  sampling profile, and a short settle curve back onto the exact
  target. Randomized per trip: no two trips trace the same route. The
  generator is pure and exported, so tests assert the curvature, the
  overshoot and the settle directly. Also `pathLength()` and
  `pickPointInBox()` (a randomized, off-center point inside an
  element's box).
- `moveTo(page, x, y, opts?)` / `click(page, locator, opts?)`
  (`src/mouse.ts`) — replay a generated path one `page.mouse.move` at
  a time with 5–12 ms randomized step delays, then press and release
  with a 45–110 ms human press duration. The cursor position is
  tracked per page (Playwright does not report it back).
- `typeText(page, locator, text, opts?)` (`src/typing.ts`) — clicks
  the field first, then sends one real key per character with 45–130 ms
  randomized delays and an occasional longer thinking pause.
- `launchSession({ profileDir, headless?, args? })` (`src/session.ts`)
  — a Playwright persistent context: the user's real browser profile,
  so logins, cookies and history survive between runs on disk. Session
  helpers: `goto()`, `currentUrl()`, `screenshot()`, `close()`, plus
  the underlying `context`/`page` for the drivers above. Running as
  root (containers, VMs) adds `--no-sandbox` automatically; a desktop
  user never hits that branch.
- `detectCheck(page)` (`src/checks.ts`) — observation only: scans
  the page for the shapes of common blockers and returns
  `{ kind, evidence }` with kind `captcha`, `verify-wall`,
  `login-wall` or `none`. It never acts on what it finds. The
  heuristics, and what they can get wrong, are documented under
  "Detection heuristics" below.
- `waitForHuman(page, opts?)` (`src/handoff.ts`) — the layer-3
  pause: poll until the detected check is gone (a human cleared it)
  or the timeout runs out and a `HandoffTimeoutError` carrying the
  last detected check is thrown. It never attempts to solve the
  check itself.

All timing/randomness knobs accept an injectable `rng`, which the
tests seed for reproducible trips.

## Check handling: layers 1 and 3 of 3

PLAN.md layers the checks: **prevent → solve → hand off.**

- **Layer 1, prevention (done):** a real profile with real sessions
  plus physically human input means most checks never trigger.
- **Layer 3, handoff (detection + pause done):** `detectCheck`
  notices a check that appeared anyway, and `waitForHuman` pauses
  the task until a human clears it. The mobile/WhatsApp tap that
  summons the human plugs into `waitForHuman`'s `onPoll` callback;
  the pause itself is complete without it.
- **Layer 2, the vision solver (not yet built):** our own solver on
  open vision models, for checks a product decides a model may
  attempt. It will sit on the same seam: `detectCheck` finds the
  check, the solver acts, `waitForHuman` remains the fallback when
  the solver cannot or should not proceed.

## Detection heuristics

`detectCheck` applies these signals in precedence order — captcha
widget, then wall text, then login wall — and reports the first that
matches, with the matched signal as its `evidence`. All of them are
heuristics: read a result as "a human should look", not as truth.

### Captcha widget → `captcha`

A *visible* element (non-zero size, not `display:none` /
`visibility:hidden`) is a captcha widget when its `src`, `class` or
`id` contains one of: `recaptcha`, `hcaptcha`, `h-captcha`,
`turnstile`, `challenges.cloudflare`, `arkose`, `funcaptcha`,
`geetest`, or the generic `captcha` — or when any visible element
carries a `data-sitekey` attribute (only captcha vendors use one).

False-positive risks:

- Pages *about* captchas (docs, tutorials, this project's own
  fixtures) can embed live demo widgets, and a widget embedded for
  some other flow (a contact form's) is still a widget even when the
  current task was not "challenged" by it. Detection says a widget
  is present and visible, not that it is blocking this task.
- The generic `captcha` token matches any class or id containing the
  word, including innocent ones like `captcha-policy-link` if such an
  element is large and visible.
- The always-present reCAPTCHA v3 badge is explicitly excluded
  (`grecaptcha-badge`): it sits on countless ordinary pages and is
  not a challenge. Invisible or zero-size widgets are ignored for
  the same reason, which means a purely invisible scoring check
  (reCAPTCHA v3 deciding silently) is *not* detected — by design:
  nothing is being asked of anyone.

### Verification text → `verify-wall`

The page's rendered text (case-insensitive, apostrophes and
whitespace normalized) contains one of: "verify you are human",
"verify you're human", "checking your browser", "are you a robot",
"prove you are human", "i'm not a robot", "just a moment",
"unusual traffic", "security check".

False-positive risks:

- Articles, support pages and error-page documentation quote these
  phrases. A page *discussing* verification reads the same as a page
  *demanding* it.
- "just a moment" and "security check" are deliberately included
  (they are what Cloudflare-style interstitials show) and are the
  two weakest phrases, appearing in ordinary prose and on legitimate
  banking/help pages.
- A real wall rendered only as images or inside a closed canvas
  produces no readable text and is missed.

### Login wall → `login-wall`

Deliberately simple: a *visible* password field together with a
visible heading, link, button or submit control whose label contains
"sign in", "log in", "login" or "sign-in".

False-positive risks, and the intended reading:

- **Any ordinary login page matches.** That is not an error in the
  detector: it cannot know whether the flow expected to arrive
  logged in. The result means "the session is being asked to
  authenticate here"; the *caller* decides whether that is a blocker
  (a flow that expected a live session hit a wall) or the plan (the
  task navigated to a login page on purpose).
- A sign-up or password-reset form with a "sign in" link in its
  header also matches.
- A login form whose button is an unlabeled icon, or whose wording
  is not English, is missed: no password-field companion signal can
  rescue an unrecognized label set.

### Handoff behavior

`waitForHuman(page, { timeoutMs = 300_000, pollIntervalMs = 2_000,
isCleared?, onPoll? })` polls `detectCheck` until the kind is `none`,
then resolves `{ cleared: true, waitedMs }`. A caller-supplied
`isCleared(page)` can replace the "kind is none" test for pages
where cleared means something more specific; detection still runs
each poll so progress and the timeout error stay informed. Every
poll (including the last) fires `onPoll({ attempt, elapsedMs,
check })` — the seam the future mobile push / UI uses to summon the
human. On timeout it throws `HandoffTimeoutError` carrying the last
detected check and the waited time. A poll that cannot read the page
at all (mid-navigation — exactly what a cleared check often causes)
counts as "not cleared yet" rather than crashing the wait; the
timeout still bounds it, so a dead page cannot hang a task forever.

## Tests

`test/path.test.ts` proves the generator's curvature, overshoot and
settle against a seeded RNG. `test/browser.test.ts` runs a real
Chromium against a local fixture page that records every mousemove
with timestamps: the click lands, the trail has many points arriving
over real time and curves off the straight line, typed text arrives
exactly, and a relaunched session on the same profile directory still
sees the previous session's localStorage. `test/checks.test.ts`
serves a fixture page per detection signal (captcha iframe,
verify-text wall, login wall, and a clean page) and exercises the
handoff both ways: a challenge a "human" clears mid-wait through the
package's own physical click (timeout 20 s, poll 200 ms), and a
challenge that never clears, rejected as `HandoffTimeoutError`
carrying the last check (timeout 1.2 s, poll 200 ms, so the suite
stays fast).

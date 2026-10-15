# Repeatable UI comparison

Run the same actions against two actual pages, then compare their screenshots.
The runner has no knowledge of OpenGrove, Mau or a backend protocol.

```sh
npm run compare -- comparisons/opengrove.mjs ./comparison-report
```

For the supplied scenario, start an isolated OpenGrove checkout at `8b365ed` with
its own local Bridge data, and run `npm run dev -- --port 4177` in this package.
`ORIGINAL_UI_URL` and `CANDIDATE_UI_URL` override the defaults (4176 and
4177/stories.html). The reference needs Chinese labels and a selected conversation.
Do not run mutation scenarios against production. This scenario only changes UI
preferences and drafts; it never creates an app or sends a message.

Open `comparison-report/index.html`. It contains reference, candidate and pixel
difference images, each assertion, viewport, target revision and any mask reason.
The CLI exits nonzero on interaction failure, an uncaught browser error, missing
capture, changed dimensions, or a visual difference above the configured limit.

A config exports two `targets` and shared `scenarios`. A target supplies `url`,
`label`, optional `revision`, `setup({page,context,scenario})` before navigation and
`ready(...)` after navigation. A scenario supplies `name`, `viewport` and
`run({page,context,target,check,capture})`. Use Playwright locators inside `run`:

```js
await page.getByRole('button', { name: 'Open' }).click();
await check('dialog opens', async () => {
  await page.getByRole('dialog').waitFor();
});
await capture('dialog', { selector: '[role="dialog"]' });
```

Both targets receive a fresh context with the same viewport, locale, device scale
and reduced-motion preference. Fonts are awaited and animations/carets are disabled
for captures. Optional `fixedTime` stabilizes the clock. Stabilize fixture data
separately; do not mask real UI failures. Masks require `{selector, reason}` and
must match elements on both targets. Rules and assertion names must agree.

Default changed-pixel allowance is 0.2%, with pixelmatch's 0.1 per-pixel color
threshold. Dimension changes always fail. The report records the actual counts.
Full product pages with intentionally different branding/data can use
`informational: true`; they appear as REVIEW ONLY and are not visual proof.
Use identical content and normal gated captures for components being preserved.
The tool does not regenerate or accept a reference baseline.

`npm run test:comparison` exercises the real CLI with identical pages, deliberately
changed pixels and a broken click handler. CI requires it to accept the first and
reject both regressions. Unit tests additionally cover dimension changes and CSS
scoping. This verifies the harness; it does not replace adding scenarios for new
features or checking browser/platform-specific behavior.

# Extraction validation — 2026-10-15

Reference: untouched OpenGrove `8b365ed2babc6caccc588cab1fa2d08488fb67a7`,
served by its native frontend and an isolated local Bridge. Candidate: component
stories using the built public package, without a service adapter.

The same Playwright actions ran against both pages, with Chinese labels, reduced
motion, 1280 × 800 desktop and 390 × 844 mobile viewports.

| Scenario | Gated captures | Result |
| --- | --- | --- |
| Appearance, desktop/mobile | Light content, theme menu, dark content | 6 captures, zero changed pixels |
| Conversation, desktop | Filled composer | 1 capture, zero changed pixels |
| Create app, desktop/mobile | Original modal and icon-picker subpage | 4 captures; mobile zero, desktop 33/29 changed pixels (under 0.008%) |

All 11 gates passed the unchanged 0.2% limit with no masks. All 24 shared interaction
assertions passed on both targets, covering theme selection, Escape closure,
IME draft preservation, search, opening the modal, title input, icon picker,
returning to the form, cancelling and reopening with an empty draft. Three full-page captures are REVIEW ONLY:
product branding, navigation data and records differ and are not pixel gates.

The comparison found and fixed actual regressions: the create form was composed
as a whole page instead of the original modal; portaled content inherited the
wrong typography and reset; controlled dialogs did not restore opener focus.

Separate browser acceptance checks component callbacks/errors, unavailable
keyboard submission, file editing/conflicts, profile tabs, responsive navigation,
unmounting and no service requests. Isolation checks load CSS into an existing
page and verify outside controls/document tokens stay unchanged, simultaneous
light/dark instances retain their own portal styling, and Escape restores focus.
Feature-style checks ensure shell imports exclude the rich editor theme.

The generic comparison CLI is itself tested with injected pixel and click
regressions; both must fail. Its current original-source scenarios do not prove
pixel identity of every page, every browser or every product state. Extend
`comparisons/opengrove.mjs` whenever a new visual surface changes. See
[comparison workflow](comparison.md) for reproduction and report semantics.

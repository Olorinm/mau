# Source extraction validation

Source: OpenGrove `8b365ed2babc6caccc588cab1fa2d08488fb67a7`.
Consumer: Mau's isolated local preview, using the packed frontend archive. The
preview uses fixture accounts/messages; it does not call a live model.

At 1280 × 633, the source and consumer have identical measured rectangles:

| Surface | x | y | width | height |
| --- | ---: | ---: | ---: | ---: |
| Conversation header | 431 | 45 | 838 | 61 |
| Composer outer surface | 431 | 502 | 838 | 114 |
| Composer input surface | 455 | 512 | 808 | 88 |
| Text input | 464 | 521 | 790 | 42 |
| Conversation list row | 147 | 218.390625 | 260 | 44 |
| Navigation account button | 10 | 583 | 106 | 36 |
| Settings content | 430 | 44 | 840 | 573 |
| Settings heading | 454 | 76 | 792 | 54.296875 |
| Appearance preferences | 454 | 158.296875 | 792 | 216 |

At 390 × 844, the settings content is `(18,124,354,720)`, its heading is
`(34,148,322,54.296875)` and its preference group is
`(34,230.296875,322,264.890625)` in both implementations. This verifies these
surfaces, not pixel identity of every page. Brand, records and connected actions
are intentionally consumer supplied.

Automated acceptance covers callback delivery and caller errors, IME Enter
suppression, unavailable builder keyboard submission, profile tabs, menus,
navigation resize, compact list/detail return, file editing/conflict resolution,
unmounting and absence of service requests. The archive is installed into an
independent consumer, typechecked, built and exercised in a browser. Mau's 38
fixture tests cover its own API and product workflows separately.

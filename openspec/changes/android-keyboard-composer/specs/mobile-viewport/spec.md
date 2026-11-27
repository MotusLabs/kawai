## ADDED Requirements

### Requirement: The layout follows the Android soft keyboard
On every Android user agent, at any layout width, the client SHALL add `interactive-widget=resizes-content` to the viewport meta before mounting, keeping its existing tokens, and SHALL keep the focused composer's bottom edge above the keyboard in a browser tab and in the installed PWA. Other platforms SHALL keep the meta unchanged.

#### Scenario: Android opts in
- **WHEN** the served page loads on an Android user agent at a layout width of 412 px and at 800 px
- **THEN** at both widths the viewport meta content is `width=device-width, initial-scale=1.0, viewport-fit=cover` plus `interactive-widget=resizes-content` exactly once, also after a reload

#### Scenario: Other platforms keep the meta
- **WHEN** the served page loads and reloads on an iPhone user agent and on a desktop browser
- **THEN** the viewport meta content is exactly `width=device-width, initial-scale=1.0, viewport-fit=cover` and no Android class is set

#### Scenario: The composer stays visible and the transcript scrolls
- **WHEN** the user focuses the composer on an Android device, in a browser tab and in the installed PWA, with a transcript longer than one screen and the keyboard open
- **THEN** the composer's bottom edge is above the keyboard's top edge, and a scroll gesture on the transcript changes its scroll position

#### Scenario: Closing the keyboard restores the layout
- **WHEN** the keyboard closes
- **THEN** the root container returns to the full dynamic viewport height and the composer sits at the bottom of the screen

#### Scenario: The standalone fallback fixes the root height
- **WHEN** the owner's device check shows the Android standalone PWA at a layout width of at most 767 px, after loading this build (its loaded hashed client entry matches the build), with the composer hidden while the separately recorded visual viewport height shrank, and the fallback is applied
- **THEN** with the keyboard open the root is as tall as the visual viewport within 1 px and the composer's bottom edge is at or above `offsetTop + height` of the visual viewport

#### Scenario: The standalone fallback stays within the mobile width
- **WHEN** the fallback is applied and an Android standalone window is 768 px or wider
- **THEN** the standalone class may be present, but the root height is not driven by the visual viewport and stays the full dynamic viewport height

### Requirement: Keyboard handling on iOS is unchanged
The system SHALL keep the existing iOS soft-keyboard behaviour: the viewport meta and startup of iOS and desktop are unchanged, and the `.ios` root alignment to the visual viewport, the `--visual-viewport-*` variables, and the `keyboard-visible` class are neither removed nor made to depend on the Android mechanism.

#### Scenario: The iOS rules still apply
- **WHEN** the page runs with the `ios` class at layout widths of exactly 390 px and exactly 767 px and the visual viewport variables are set to distinguishable values
- **THEN** at both widths `#root` is fixed and takes the declared width, height and offset

#### Scenario: The iOS rules are inactive at 768 px and wider
- **WHEN** the same page runs with the `ios` class at layout widths of exactly 768 px and 800 px
- **THEN** at both widths `#root` is not fixed and takes no iOS size or offset

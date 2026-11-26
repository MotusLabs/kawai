## ADDED Requirements

### Requirement: The layout follows the Android soft keyboard
On Android the client SHALL add `interactive-widget=resizes-content` to the viewport meta before mounting, keeping its existing tokens, and SHALL keep the focused composer's bottom edge above the keyboard in a browser tab and in the installed PWA. Other platforms SHALL keep the meta unchanged.

#### Scenario: Android opts in
- **WHEN** the served page loads on an Android user agent
- **THEN** the viewport meta content is `width=device-width, initial-scale=1.0, viewport-fit=cover` plus `interactive-widget=resizes-content` exactly once, also after a reload

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
- **WHEN** the owner's device check shows the Android standalone PWA, after loading this build, with the composer hidden while the visual viewport shrank, and the fallback is applied
- **THEN** with the keyboard open the root is as tall as the visual viewport within 1 px and the composer's bottom edge is at or above `offsetTop + height` of the visual viewport

### Requirement: Keyboard handling on iOS is unchanged
The system SHALL keep the existing iOS soft-keyboard behaviour: the viewport meta and startup of iOS and desktop are unchanged, and the `.ios` root alignment to the visual viewport, the `--visual-viewport-*` variables, and the `keyboard-visible` class are neither removed nor made to depend on the Android mechanism.

#### Scenario: The iOS rules still apply
- **WHEN** the page runs with the `ios` class at a viewport width of at most 767 px and the visual viewport variables are set to distinguishable values
- **THEN** `#root` is fixed and takes the declared width, height and offset

#### Scenario: The iOS rules are inactive at 768 px and wider
- **WHEN** the same page runs with the `ios` class at 768 px or wider
- **THEN** `#root` is not fixed and takes no iOS size or offset

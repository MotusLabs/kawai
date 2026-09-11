import { chromium } from '@playwright/test'

// CI uses this to distinguish "browser binary missing" from "system libraries
// missing": a successful launch means no further setup, while a failure is
// Playwright's own list of the exact .so files the image lacks.
const browser = await chromium.launch()
await browser.close()
console.log('chromium launches')

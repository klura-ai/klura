/**
 * custom-driver.js — starting point for a custom klura browser driver.
 *
 * Extend PlaywrightDriver and override createSession to configure the browser
 * context. Everything else (click, type, screenshot, a11y tree, network
 * intercept, remote viewer, touch dispatch, ...) is inherited.
 *
 * Usage — point config.json at this file:
 *
 *   ~/.klura/config.json:
 *   {
 *     "pool": {
 *       "driver": "/absolute/path/to/custom-driver.js"
 *     }
 *   }
 *
 * The daemon loads the module on startup and uses it for all sessions.
 * Export the class as `module.exports` (CommonJS default export).
 *
 * Dependencies: the `klura` package must be installed (npm install -g klura).
 * Any additional packages used below must be installed separately.
 */

'use strict';

const { PlaywrightDriver } = require('klura');
const { chromium } = require('playwright');

class CustomDriver extends PlaywrightDriver {
  /**
   * Override createSession to customise launch args and context options.
   *
   * The parent class manages browser lifecycle (lazy start, idle hibernate),
   * session tracking, network interception, focus tracking, and storage state.
   * You only need to change what differs from the default Playwright setup.
   *
   * @param {import('klura').SessionOptions} options
   * @returns {Promise<import('klura').Session>}
   */
  async createSession(options = {}) {
    // --- Customise browser launch args here ---
    // Examples of things you might change:
    //
    //   args: ['--disable-blink-features=AutomationControlled']
    //   executablePath: '/path/to/your/browser'
    //   headless: false   (headed mode, useful for debugging)
    //
    // If you install a third-party stealth/patching library, this is where
    // you'd apply it — before or after launching. The call below matches
    // what PlaywrightDriver does internally; adjust as needed.

    const browser = await chromium.launch({
      headless: true,
      args: [
        // Add your custom launch flags here.
      ],
    });

    // --- Customise browser context here ---
    // Context options control viewport, user agent, locale, timezone, etc.
    // Playwright's newContext() accepts all BrowserContextOptions.

    const contextOptions = {
      viewport: { width: 1280, height: 800 },
      // userAgent: 'Mozilla/5.0 ...',
      // locale: 'en-US',
      // timezoneId: 'America/New_York',
      // geolocation: { latitude: 40.7128, longitude: -74.0060 },
      // permissions: ['geolocation'],
    };

    if (options.storageState) {
      contextOptions.storageState = options.storageState;
    }
    if (options.hasTouch) {
      contextOptions.hasTouch = true;
      contextOptions.isMobile = options.isMobile ?? false;
    }
    if (options.viewport) {
      contextOptions.viewport = options.viewport;
    }
    if (options.userAgent) {
      contextOptions.userAgent = options.userAgent;
    }

    const context = await browser.newContext(contextOptions);

    // --- Add init scripts here ---
    // Scripts added via addInitScript run on every page load before any page
    // JS, including navigation within the session. Use this to patch globals.

    // await context.addInitScript(() => {
    //   // Runs in page context before page JS — customise as needed.
    // });

    const page = await context.newPage();

    // Build the Session object. The id, browser, context, page, intercepted,
    // and intercepting fields are required by the BrowserDriver interface.
    const session = {
      id: `sess_${Math.random().toString(36).slice(2, 14)}`,
      browser,
      context,
      page,
      intercepted: [],
      intercepting: false,
    };

    // Enable network interception (required for get_network_log and
    // page-script strategies that check API responses). Remove this block
    // only if you know you don't need network logging.
    this.startIntercepting(session);

    return session;
  }
}

module.exports = CustomDriver;

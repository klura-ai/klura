import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import type { JsonValueV1 } from '../../../public/contracts/json';
import { PublicHttpExecutionError, type PublicBrowserIdentityV1 } from '../node-http';
import type { PinnedEgressProxyV1 } from './pinned-proxy';

export interface PublicSinglePageGuardV1 {
  assertHealthy(): void;
}

/** The one desktop profile every public browser task renders under. A package
 *  then sees the same page on every machine, and the page sees an ordinary
 *  desktop browser rather than a bare automation default. */
export const PUBLIC_BROWSER_PROFILE_V1 = {
  viewport: { width: 1536, height: 864 },
  device_scale_factor: 1,
  locale: 'en-US',
  timezone_id: 'UTC',
  color_scheme: 'light',
} as const;

const PUBLIC_BROWSER_ARGS = [
  '--disable-quic',
  '--disable-features=WebTransport,MediaRouter',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-extensions',
  '--disable-sync',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--proxy-bypass-list=<-loopback>',
  // The engine is Chrome; `navigator.webdriver` must say what an ordinary Chrome says.
  '--disable-blink-features=AutomationControlled',
];

export interface PublicBrowserLaunchV1 {
  browser: Browser;
  identity: PublicBrowserIdentityV1;
  /** The browser's own user agent with the headless marker removed: the engine
   *  and version it reports are real, and the hidden window is not a product. */
  user_agent: string;
}

async function presentedUserAgent(browser: Browser): Promise<string> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const agent = String(await page.evaluate('navigator.userAgent'));
    return agent.replace('HeadlessChrome/', 'Chrome/');
  } finally {
    await context.close();
  }
}

let warnedChromiumFallback = false;

/** Said once per process: the operator needs to know their packages no longer
 *  render in the browser they were authored against. */
function warnChromiumFallback(cause: Error): void {
  if (warnedChromiumFallback) return;
  warnedChromiumFallback = true;
  console.warn(
    `[klura] public browser: Google Chrome is not available (${cause.message.split('\n')[0]}); ` +
      'falling back to bundled Chromium. Sites may serve it a reduced page. Install Google Chrome to match the authoring browser.',
  );
}

/**
 * Launches the public browser: the installed Google Chrome when present, since
 * its transport fingerprint and rendering are those of an ordinary browser and
 * sites serve it their full page, and Playwright's bundled Chromium otherwise.
 * Headless runs use `--headless=new`, the real engine with a hidden window,
 * never the separate headless shell. The fallback is never silent: it is
 * warned once per process and named on every response it produces.
 */
export async function launchPublicBrowser(
  proxy: PinnedEgressProxyV1,
  options: { headless?: boolean } = {},
): Promise<PublicBrowserLaunchV1> {
  const headless = options.headless ?? true;
  const launch = {
    headless: false,
    chromiumSandbox: true,
    proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
    args: headless ? [...PUBLIC_BROWSER_ARGS, '--headless=new'] : PUBLIC_BROWSER_ARGS,
  };
  let chrome: Browser | null = null;
  try {
    chrome = await chromium.launch({ ...launch, channel: 'chrome' });
  } catch (error) {
    warnChromiumFallback(asError(error));
  }
  if (chrome !== null) {
    return { browser: chrome, identity: 'chrome', user_agent: await presentedUserAgent(chrome) };
  }
  try {
    const browser = await chromium.launch(launch);
    return { browser, identity: 'chromium', user_agent: await presentedUserAgent(browser) };
  } catch (error) {
    throw new PublicHttpExecutionError(
      'browser_unavailable',
      `public browser launch failed: ${asError(error).message}`,
    );
  }
}

export function createPublicBrowserContextOptions(
  storageState: JsonValueV1 | undefined,
  userAgent?: string,
): BrowserContextOptions {
  return {
    ...(userAgent === undefined ? {} : { userAgent }),
    viewport: { ...PUBLIC_BROWSER_PROFILE_V1.viewport },
    deviceScaleFactor: PUBLIC_BROWSER_PROFILE_V1.device_scale_factor,
    locale: PUBLIC_BROWSER_PROFILE_V1.locale,
    timezoneId: PUBLIC_BROWSER_PROFILE_V1.timezone_id,
    colorScheme: PUBLIC_BROWSER_PROFILE_V1.color_scheme,
    serviceWorkers: 'block',
    acceptDownloads: false,
    ...(storageState === undefined
      ? {}
      : { storageState: storageState as BrowserContextOptions['storageState'] }),
  };
}

/**
 * Keeps every public browser task inside its one policy-bearing page target.
 *
 * The context-level route is installed before target navigation so popup
 * requests cannot race ahead of the page-scoped CDP boundary.
 */
export async function installPublicSinglePageGuard(
  context: BrowserContext,
  primaryPage: Page,
): Promise<PublicSinglePageGuardV1> {
  let violation: PublicHttpExecutionError | null = null;
  const blockPopup = (candidate: Page): void => {
    if (candidate === primaryPage) return;
    violation ??= new PublicHttpExecutionError(
      'request_blocked',
      'public browser blocked a popup target',
    );
    void candidate.close();
  };
  context.on('page', blockPopup);
  await context.route('**/*', async (route) => {
    try {
      if (route.request().frame().page() === primaryPage) {
        await route.fallback();
        return;
      }
    } catch {
      // Requests without an attributable primary-page frame fail closed below.
    }
    violation ??= new PublicHttpExecutionError(
      'request_blocked',
      'public browser blocked a request outside its policy-bearing page',
    );
    await route.abort('blockedbyclient');
  });
  return {
    assertHealthy: (): void => {
      if (violation !== null) throw violation;
    },
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

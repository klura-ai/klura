import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import type { JsonValueV1 } from '../../../public/contracts/json';
import { PublicHttpExecutionError } from '../node-http';
import type { PinnedEgressProxyV1 } from './pinned-proxy';

export interface PublicSinglePageGuardV1 {
  assertHealthy(): void;
}

export async function launchPublicBrowser(
  proxy: PinnedEgressProxyV1,
  options: { headless?: boolean } = {},
): Promise<Browser> {
  try {
    return await chromium.launch({
      headless: options.headless ?? true,
      chromiumSandbox: true,
      proxy: { server: proxy.server, username: proxy.username, password: proxy.password },
      args: [
        '--disable-quic',
        '--disable-features=WebTransport,MediaRouter',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-extensions',
        '--disable-sync',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--proxy-bypass-list=<-loopback>',
      ],
    });
  } catch (error) {
    throw new PublicHttpExecutionError(
      'browser_unavailable',
      `public browser launch failed: ${asError(error).message}`,
    );
  }
}

export function createPublicBrowserContextOptions(
  storageState: JsonValueV1 | undefined,
): BrowserContextOptions {
  return {
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

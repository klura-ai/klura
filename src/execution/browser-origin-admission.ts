import type { BrowserDriver } from '../drivers/interface';
import type { Session } from '../drivers/types/session';
import { acquireLocalOriginPermit, localRequestTimeoutMs } from './local-traffic';
import { recordDiagnosticUrl } from './diagnostic-evidence';

export async function navigateWithOriginAdmission(
  session: Session,
  driver: BrowserDriver,
  url: string,
  workload: string,
  options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'networkidle' },
): Promise<void> {
  const permit = await acquireLocalOriginPermit(url, workload);
  try {
    recordDiagnosticUrl('request', url);
    await driver.navigate(session, url, {
      ...options,
      timeout_ms: localRequestTimeoutMs(),
    });
    permit.release('success');
  } catch (error) {
    permit.release('neutral');
    throw error;
  }
}

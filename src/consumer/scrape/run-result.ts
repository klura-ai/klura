import type { RunCancellationSourceV1, RunCompletionStopV1, RunIdV1, RunStopV1 } from './journal';
import type { ScrapeRunSummaryV1 } from './run-state';

export type LocalScrapeRunResultV1 =
  | {
      kind: 'scrape_outcome';
      run_id: RunIdV1;
      summary: ScrapeRunSummaryV1;
      stop: RunCompletionStopV1;
    }
  | {
      kind: 'scrape_partial' | 'scrape_failure';
      run_id: RunIdV1;
      summary: ScrapeRunSummaryV1;
      stop: RunStopV1;
    };

export interface StartedScrapeRunV1 {
  run_id: RunIdV1;
  completion: Promise<LocalScrapeRunResultV1>;
  cancel(source?: RunCancellationSourceV1): boolean;
}

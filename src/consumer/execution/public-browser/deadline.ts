import {
  PublicHttpExecutionError,
  type PublicDeniedResourceV1,
  type PublicExecutionStageV1,
} from '../node-http';

/** The error for a browser task whose deadline passed. It names the stage that
 *  was running and the page requests the policy refused along the way, so the
 *  author sees both where the time went and what the page was still waiting
 *  for without re-running the call. */
export function deadlineExpired(
  task: string,
  stage: PublicExecutionStageV1,
  targetRequests: number,
  deniedResources: readonly PublicDeniedResourceV1[],
): PublicHttpExecutionError {
  return new PublicHttpExecutionError(
    'request_timeout',
    `${task} deadline expired during ${stage}`,
    targetRequests,
    null,
    {
      kind: 'deadline_expired',
      stage,
      target_requests: targetRequests,
      denied_resources: [...deniedResources],
    },
  );
}

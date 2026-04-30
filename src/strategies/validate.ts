// Save-time validator surface. skills.ts imports every name exposed here and
// chains them under saveStrategy's try/accumulate wrapper. Each validator lives
// in a topic module under ./validate/; this file is a composition-only barrel.

export {
  setTryGeneratorStatsProvider,
  getTryGeneratorStatsForSession,
  setDeclaredArgsProvider,
  setCapturedRequestsProvider,
} from './validate/providers';

export {
  describeNotesAllowlist,
  JS_EVAL_TIMEOUT_HARD_CAP_MS,
  JS_EVAL_TIMEOUT_DEFAULT_MS,
  WireProtocol,
} from './validate/constants';

export { validateStrategyShape } from './validate/shape';
export { validateNoOpaqueUserParams } from './validate/opaque-params';
export { validateCapabilityPrereqs } from './validate/capability-prereqs';
export {
  validateNoSelectorSelfReference,
  validateNoSynthesizedAuthHeaders,
  validatePlaceholderReferences,
} from './validate/selectors';
export { extractBundledIssues } from './validate/bundled-issues';

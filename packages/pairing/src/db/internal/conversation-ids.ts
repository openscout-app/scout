/**
 * Shared operator/read-model identity helpers.
 *
 * Chat IDs are opaque. This module intentionally does not re-export structural
 * `dm.*` builders or parsers.
 */

export {
  configuredOperatorActorIds,
  conversationIdAliases,
  isLikelyLocalSessionAgentId,
} from "@openscout/runtime/routing";

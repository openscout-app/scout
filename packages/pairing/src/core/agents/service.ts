import {
  createScoutAgentService,
  type CreateScoutAgentCardInput,
  type CleanupScoutAgentCardsInput,
  type ScoutAgentStatus,
  type UpdateScoutAgentCardInput,
  type UpScoutAgentInput,
} from "@openscout/runtime/harnesses";

import {
  loadScoutBrokerContext,
  openScoutPeerSession,
  registerScoutLocalAgentBinding,
  retireScoutLocalAgentBinding,
} from "../broker/service.ts";

const scoutAgentService = createScoutAgentService({
  loadScoutBrokerContext,
  openScoutPeerSession,
  registerScoutLocalAgentBinding,
  retireScoutLocalAgentBinding,
});

export type {
  CreateScoutAgentCardInput,
  CleanupScoutAgentCardsInput,
  ScoutAgentStatus,
  UpdateScoutAgentCardInput,
  UpScoutAgentInput,
};

export const {
  cleanupScoutAgentCards,
  createScoutAgentCard,
  downAllScoutAgents,
  downScoutAgent,
  loadScoutAgentStatuses,
  retireScoutAgentCard,
  restartScoutAgents,
  updateScoutAgentCard,
  upScoutAgent,
} = scoutAgentService;

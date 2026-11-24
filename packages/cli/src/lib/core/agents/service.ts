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

export const cleanupScoutAgentCards = scoutAgentService.cleanupScoutAgentCards;
export const createScoutAgentCard = scoutAgentService.createScoutAgentCard;
export const downAllScoutAgents = scoutAgentService.downAllScoutAgents;
export const downScoutAgent = scoutAgentService.downScoutAgent;
export const loadScoutAgentStatuses = scoutAgentService.loadScoutAgentStatuses;
export const retireScoutAgentCard = scoutAgentService.retireScoutAgentCard;
export const restartScoutAgents = scoutAgentService.restartScoutAgents;
export const updateScoutAgentCard = scoutAgentService.updateScoutAgentCard;
export const upScoutAgent = scoutAgentService.upScoutAgent;

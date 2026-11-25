import { runAutoSubscriptionTurn } from "../security/subscription-policy.js";
import { runLiveTurnWithSendRecovery } from "./live-send-recovery.js";

/** Shared model-round protocol; target workers retain their durable queues/cutoffs. */
export async function runConversationTurn({ agent, request, autoSubscription = null, onRecovery = () => {} }) {
  if (autoSubscription) {
    return runAutoSubscriptionTurn({ ...autoSubscription, prompt: request.prompt,
      runTurn: (prompt) => agent.runTurn({ ...request, prompt }) });
  }
  return { result: await runLiveTurnWithSendRecovery((turn) => agent.runTurn(turn), request, { onRecovery }) };
}

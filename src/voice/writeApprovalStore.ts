import { randomUUID } from "node:crypto";

export interface VoiceWriteProposal {
  id: string;
  userId: string;
  guildId: string;
  channelId: string;
  sessionKey: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

export class VoiceWriteApprovalStore {
  private readonly proposals = new Map<string, VoiceWriteProposal>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  create(
    input: Omit<VoiceWriteProposal, "id" | "createdAt" | "expiresAt">,
    now = Date.now(),
  ): VoiceWriteProposal {
    this.deleteExpired(now);
    const proposal: VoiceWriteProposal = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.proposals.set(proposal.id, proposal);
    return proposal;
  }

  take(
    id: string,
    userId: string,
    now = Date.now(),
  ): VoiceWriteProposal | null {
    this.deleteExpired(now);
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.userId !== userId) {
      return null;
    }
    this.proposals.delete(id);
    return proposal;
  }

  cancel(id: string, userId: string, now = Date.now()): boolean {
    return this.take(id, userId, now) !== null;
  }

  private deleteExpired(now: number): void {
    for (const [id, proposal] of this.proposals) {
      if (proposal.expiresAt <= now) {
        this.proposals.delete(id);
      }
    }
  }
}

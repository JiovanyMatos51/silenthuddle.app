import type { ChatMessage, PublicHistoryEntry, HistoryReaction } from "./types";

interface HistoryView {
  message: ChatMessage;
  reactions: Map<string, Set<string>>;
  reactionEvents?: Map<string, HistoryReaction>;
}

/** Never exports local system notices or private conversations. */
export function snapshotPublicHistory(views: Iterable<HistoryView>): PublicHistoryEntry[] {
  return Array.from(views)
    .filter((view) => view.message.kind === "normal" || view.message.kind === "warn" || !view.message.kind)
    .map(({ message, reactions, reactionEvents }) => ({
      message: {
        id: message.id, authorId: message.authorId, author: message.author,
        text: message.text, time: message.time, createdAt: message.createdAt ?? Date.now(),
        avatarColor: message.avatarColor, kind: message.kind === "warn" ? "warn" as const : "normal" as const,
        replyTo: message.replyTo,
      },
      reactions: reactionEvents ? Array.from(reactionEvents.values())
        : Array.from(reactions).flatMap(([emoji, peerIds]) =>
          Array.from(peerIds, (peerId) => ({ peerId, emoji, active: true, revision: 1 }))),
    }));
}

export function* historyBatches(entries: PublicHistoryEntry[]): Generator<PublicHistoryEntry[]> {
  let batch: PublicHistoryEntry[] = [];
  let size = 0;
  for (const original of entries) {
    for (const entry of splitEntry(original)) {
      const bytes = new TextEncoder().encode(JSON.stringify(entry)).length;
      if (batch.length && (size + bytes > 48 * 1024 || batch.length >= 100)) {
        yield batch;
        batch = [];
        size = 0;
      }
      batch.push(entry);
      size += bytes;
    }
  }
  if (batch.length) yield batch;
}

/** Large reaction histories are fragmented without dropping their message. */
function* splitEntry(entry: PublicHistoryEntry): Generator<PublicHistoryEntry> {
  const baseSize = new TextEncoder().encode(JSON.stringify({ message: entry.message, reactions: [] })).length;
  let size = baseSize;
  let reactions: HistoryReaction[] = [];
  for (const event of entry.reactions) {
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length + 1;
    if (reactions.length && (size + bytes > 48 * 1024 || reactions.length >= 384)) {
      yield { message: entry.message, reactions };
      reactions = [];
      size = baseSize;
    }
    reactions.push(event);
    size += bytes;
  }
  yield { message: entry.message, reactions };
}

export function validHistoryEntry(value: unknown): value is PublicHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as PublicHistoryEntry;
  const m = entry.message;
  return Boolean(m && typeof m.id === "string" && m.id.length <= 64
    && typeof m.authorId === "string" && m.authorId.length <= 64
    && typeof m.author === "string" && m.author.length <= 18
    && typeof m.text === "string" && m.text.length <= 8_192
    && typeof m.time === "string" && m.time.length <= 32
    && (m.avatarColor === undefined || typeof m.avatarColor === "string" && m.avatarColor.length <= 64)
    && (m.replyTo === undefined || m.replyTo && typeof m.replyTo.peerId === "string"
      && m.replyTo.peerId.length <= 64 && typeof m.replyTo.nickname === "string" && m.replyTo.nickname.length <= 18)
    && Number.isFinite(m.createdAt) && (m.kind === "normal" || m.kind === "warn")
    && Array.isArray(entry.reactions) && entry.reactions.length <= 384
    && entry.reactions.every((reaction) => reaction && typeof reaction.emoji === "string" && reaction.emoji.length <= 16
      && typeof reaction.peerId === "string" && reaction.peerId.length <= 64
      && typeof reaction.active === "boolean" && Number.isSafeInteger(reaction.revision) && reaction.revision > 0));
}

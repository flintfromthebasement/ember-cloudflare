import { describe, expect, it } from "vitest";
import type { Message } from "@ember/protocol";
import { commentsReducer, hasOlderComments, initialCommentsState, shownComments, type CommentsState } from "./comments-state";

const ada = { id: "ada", name: "Ada" };
const grace = { id: "grace", name: "Grace" };

// Ids sort by when they were made, as the room's do.
const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  clientMessageId: `c-${id}`,
  roomId: "room",
  creator: ada,
  body: `<p>${id}</p>`,
  plainText: id,
  mentions: [],
  createdAt: "2026-11-10T12:00:00.000Z",
  updatedAt: "2026-11-10T12:00:00.000Z",
  editedAt: null,
  boosts: [],
  parentId: "post",
  alsoSent: false,
  ...extra,
});

const created = (state: CommentsState, m: Message, me = "ada") => commentsReducer(state, { type: "frame", frame: { type: "message.created", message: m, seq: 1 }, me });
const ids = (messages: Message[]) => messages.map((m) => m.id);

describe("commentsReducer", () => {
  it("shows the newest comments, then every one it knows as pages of older ones come", () => {
    let state = initialCommentsState("post", [message("05"), message("04")]);
    expect(ids(shownComments(state))).toEqual(["04", "05"]);
    state = commentsReducer(state, { type: "frame", frame: { type: "comments", parentId: "post", before: "04", comments: [message("03"), message("02")], hasMore: true }, me: "ada" });
    expect(ids(shownComments(state))).toEqual(["02", "03", "04", "05"]);
    expect(hasOlderComments(state, 10)).toBe(true);
    state = commentsReducer(state, { type: "frame", frame: { type: "comments", parentId: "other", before: null, comments: [message("01")], hasMore: false }, me: "ada" });
    expect(ids(state.comments)).toEqual(["02", "03", "04", "05"]);
  });

  it("holds others' new comments back until shown, and shows your own at once", () => {
    let state = initialCommentsState("post", [message("01")]);
    state = created(state, message("02", { creator: grace }));
    expect(ids(shownComments(state))).toEqual(["01"]);
    expect(state.unseen).toEqual(["02"]);
    state = created(state, message("03"));
    expect(ids(shownComments(state))).toEqual(["01", "03"]);
    state = commentsReducer(state, { type: "show-unseen" });
    expect(ids(shownComments(state))).toEqual(["02", "03"]);
  });

  it("opens a comment's replies oldest first, adds those that come while open, and your own, and leaves other threads' alone", () => {
    let state = initialCommentsState("post", [message("01", { replyCount: 3 })]);
    state = created(state, message("04", { creator: grace, replyToId: "01" }));
    expect(state.replies["01"]).toBeUndefined();
    state = commentsReducer(state, { type: "frame", frame: { type: "replies", commentId: "01", after: null, replies: [message("02", { replyToId: "01" }), message("03", { replyToId: "01" })], hasMore: true }, me: "ada" });
    expect(ids(state.replies["01"]!.replies)).toEqual(["02", "03"]);
    state = created(state, message("05", { creator: grace, replyToId: "01" }));
    expect(ids(state.replies["01"]!.replies)).toEqual(["02", "03", "05"]);
    state = created(state, message("06", { parentId: "other", replyToId: "x" }));
    expect(state.replies.x).toBeUndefined();
  });

  it("changes, reacts to and deletes comments and replies wherever they show", () => {
    let state = initialCommentsState("post", [message("01")]);
    state = created(state, message("02", { replyToId: "01" }));
    state = commentsReducer(state, { type: "frame", frame: { type: "message.updated", message: message("01", { replyCount: 1 }), seq: 2 }, me: "ada" });
    expect(state.comments[0]!.replyCount).toBe(1);
    state = commentsReducer(state, { type: "frame", frame: { type: "message.deleted", messageId: "02", seq: 3 }, me: "ada" });
    expect(state.replies["01"]!.replies).toEqual([]);
    state = commentsReducer(state, { type: "frame", frame: { type: "message.deleted", messageId: "01", seq: 4 }, me: "ada" });
    expect(state.comments).toEqual([]);
  });

  it("tells whether there are older comments from the thread's count until a page says", () => {
    const state = initialCommentsState("post", [message("02", { replyCount: 2 }), message("03")]);
    expect(hasOlderComments(state, 4)).toBe(false);
    expect(hasOlderComments(state, 5)).toBe(true);
  });
});

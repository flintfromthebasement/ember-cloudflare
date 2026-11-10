import { describe, expect, it } from "vitest";
import type { Boost, Message, Post } from "@ember/protocol";
import { initialPostsState, postsReducer, type PostsState } from "./posts-state";

const ada = { id: "ada", name: "Ada" };

const message = (id: string, parentId?: string): Message => ({
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
  ...(parentId !== undefined && { parentId, alsoSent: false }),
});

const post = (id: string, replies: string[] = []): Post => ({ message: message(id), replies: replies.map((r) => message(r, id)), activeId: replies.at(-1) ?? id });

const loaded = (posts: Post[], hasMore = false): PostsState =>
  postsReducer(initialPostsState, { type: "frame", frame: { type: "posts", before: null, posts, hasMore } });

const ids = (state: PostsState) => state.posts.map((p) => p.message.id);

describe("postsReducer", () => {
  it("shows the newest page in place of what it showed, and adds older pages after it, once each", () => {
    const state = loaded([post("p3"), post("p2")], true);
    expect(state).toMatchObject({ loaded: true, loading: false, hasMore: true });
    const older = postsReducer(state, { type: "frame", frame: { type: "posts", before: "p2", posts: [post("p2"), post("p1")], hasMore: false } });
    expect(ids(older)).toEqual(["p3", "p2", "p1"]);
    expect(older.hasMore).toBe(false);
    expect(ids(postsReducer(older, { type: "frame", frame: { type: "posts", before: null, posts: [post("p4")], hasMore: true } }))).toEqual(["p4"]);
  });

  it("puts a new post on top, and brings a post to the top with a reply, keeping its newest replies", () => {
    // Ids sort by when they were made, as the room's do.
    let state = loaded([post("02"), post("01", ["03", "04"])].sort((a, b) => (a.activeId < b.activeId ? 1 : -1)));
    expect(ids(state)).toEqual(["01", "02"]);
    state = postsReducer(state, { type: "frame", frame: { type: "message.created", message: message("05"), seq: 1 } });
    expect(ids(state)).toEqual(["05", "01", "02"]);
    state = postsReducer(state, { type: "frame", frame: { type: "message.created", message: message("06", "02"), seq: 2 } });
    expect(ids(state)).toEqual(["02", "05", "01"]);
    expect(state.posts[0]!.replies.map((r) => r.id)).toEqual(["06"]);
    expect(state.posts[0]!.activeId).toBe("06");
    state = postsReducer(state, { type: "frame", frame: { type: "message.created", message: message("07", "01"), seq: 3 } });
    expect(ids(state)).toEqual(["01", "02", "05"]);
    expect(state.posts[0]!.replies.map((r) => r.id)).toEqual(["04", "07"]);
  });

  it("asks again when a reply comes to a post it doesn't have", () => {
    const state = postsReducer(loaded([post("p2")]), { type: "frame", frame: { type: "message.created", message: message("r9", "p0"), seq: 1 } });
    expect(state.stale).toBe(true);
  });

  it("changes, reacts to and deletes posts and replies wherever they show", () => {
    let state = loaded([post("p1", ["r1"])]);
    const edited = { ...message("r1", "p1"), plainText: "edited" };
    state = postsReducer(state, { type: "frame", frame: { type: "message.updated", message: edited, seq: 1 } });
    expect(state.posts[0]!.replies[0]!.plainText).toBe("edited");
    const boost: Boost = { id: "b1", messageId: "p1", booster: ada, content: "👍", createdAt: "2026-11-10T12:01:00.000Z" } as Boost;
    state = postsReducer(state, { type: "frame", frame: { type: "boost.created", boost, seq: 2 } });
    expect(state.posts[0]!.message.boosts).toEqual([boost]);
    state = postsReducer(state, { type: "frame", frame: { type: "boost.deleted", boostId: "b1", messageId: "p1", seq: 3 } });
    expect(state.posts[0]!.message.boosts).toEqual([]);
    state = postsReducer(state, { type: "frame", frame: { type: "message.deleted", messageId: "r1", seq: 4 } });
    expect(state.posts[0]!.replies).toEqual([]);
    state = postsReducer(state, { type: "frame", frame: { type: "message.deleted", messageId: "p1", seq: 5 } });
    expect(state.posts).toEqual([]);
  });
});

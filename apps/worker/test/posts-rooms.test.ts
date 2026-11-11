import { COMMENT_REPLIES_PAGE_SIZE, POST_REPLIES_SHOWN, type Message, type RoomId, type RoomSettings, type SharedRoom, type Sidebar } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { api, connect, createRoom, freshDeploy, freshRoom, post, post as post_, signIn, startUpload, workspaceSql, type Session, type Socket } from "./support";

// Posts rooms, as a community's forum has them: every message is a post, answered in its thread, and the
// room lists its posts newest activity first, each with its newest replies.

beforeEach(freshDeploy);

const change = (roomId: RoomId, session: Session, body: unknown) =>
  api(`/api/rooms/${roomId}`, { method: "PATCH", headers: { Cookie: session.cookie }, body: JSON.stringify(body) });

/** The rooms `session`'s person sees listed, by id, with whether each is a posts room, DMs aside. */
const postsRooms = async (session: Session) =>
  Object.fromEntries(
    ((await (await api("/api/sidebar", { headers: { Cookie: session.cookie } })).json()) as Sidebar).rooms.flatMap((room) =>
      room.kind === "direct" ? [] : [[room.id, room.posts === true]],
    ),
  );

const stored = async (roomId: RoomId) => (await workspaceSql("SELECT posts FROM rooms WHERE id = ?", roomId))[0];

/** Replies in `parent`'s thread as `client`, and waits for the room to confirm it. */
async function reply(client: Socket, parent: Pick<Message, "id">, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** Replies to comment `replyToId` in `parent`'s thread as `client`, and waits for the room to confirm it. */
async function answer(client: Socket, parent: Pick<Message, "id">, replyToId: string, body: string): Promise<Message> {
  const clientMessageId = crypto.randomUUID();
  client.send({ type: "message.create", clientMessageId, body, parentId: parent.id, replyToId });
  for (;;) {
    const { message } = await client.next("message.created");
    if (message.clientMessageId === clientMessageId) return message;
  }
}

/** The next change `client` hears to message `id`. */
async function updated(client: Socket, id: string): Promise<Message> {
  for (;;) {
    const { message } = await client.next("message.updated");
    if (message.id === id) return message;
  }
}

/** The room's posts as `client` asks for them, before the activity `before` names or the newest. */
async function postsOf(client: Socket, before?: string, limit?: number) {
  client.send({ type: "posts.before", ...(before !== undefined && { before }), ...(limit !== undefined && { limit }) });
  return client.next("posts");
}

describe("Posts rooms", () => {
  it("makes a posts room, lists it as one for everyone in it, and leaves it out of a room of chat", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const forum = await createRoom("Community", { posts: true, as: ada });
    const chat = await createRoom("Random", { as: ada });

    expect(forum.posts).toBe(true);
    expect(chat).not.toHaveProperty("posts");
    expect(await postsRooms(grace)).toEqual({ [forum.id]: true, [chat.id]: false });
    expect(await stored(forum.id)).toEqual({ posts: 1 });
    const settings = (await (await api(`/api/rooms/${forum.id}/settings`, { headers: { Cookie: grace.cookie } })).json()) as RoomSettings;
    expect(settings.room.posts).toBe(true);
  });

  it("turns a room into a posts room and back, keeping the setting when a change leaves it out", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Community", { as: ada });

    expect(((await (await change(room.id, ada, { posts: true })).json()) as { room: SharedRoom }).room).toEqual({ ...room, posts: true });
    expect(await stored(room.id)).toEqual({ posts: 1 });
    expect((await change(room.id, ada, { name: "Members", icon: "coffee" })).status).toBe(200);
    expect(await stored(room.id)).toEqual({ posts: 1 });
    const back = ((await (await change(room.id, ada, { posts: false })).json()) as { room: SharedRoom }).room;
    expect(back).not.toHaveProperty("posts");
    expect(await stored(room.id)).toEqual({ posts: 0 });
  });

  it("refuses a posts setting that isn't true or false, and records no change when it stays as it is", async () => {
    const ada = await signIn("Ada");
    const room = await createRoom("Community", { posts: true, as: ada });

    for (const posts of ["yes", 1, null]) {
      const changed = await change(room.id, ada, { posts });
      expect(changed.status).toBe(422);
      expect(await changed.json()).toEqual({ error: "Posts must be true or false" });
      const made = await api("/api/rooms", { method: "POST", headers: { Cookie: ada.cookie }, body: JSON.stringify({ kind: "open", name: "Another", posts }) });
      expect(made.status).toBe(422);
    }
    await workspaceSql("UPDATE rooms SET updated_at = 'then' WHERE id = ?", room.id);
    expect((await change(room.id, ada, { posts: true })).status).toBe(200);
    expect(await workspaceSql("SELECT updated_at FROM rooms WHERE id = ?", room.id)).toEqual([{ updated_at: "then" }]);
  });

  it("lists posts newest activity first, a reply bringing its post to the top, with each post's newest replies", async () => {
    const room = await freshRoom("posts-order");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const first = await post(ada, "<p>Introduce yourselves</p>");
    const second = await post(ada, "<p>Book club this week</p>");
    const third = await post(grace, "<p>Wins of the week</p>");

    const replies = [];
    for (const text of ["Hi, I'm Grace", "Hi, I'm Lin", "Welcome!"]) replies.push(await reply(grace, first, `<p>${text}</p>`));

    const { posts, hasMore, before } = await postsOf(ada);
    expect(before).toBeNull();
    expect(hasMore).toBe(false);
    expect(posts.map(({ message }) => message.id)).toEqual([first.id, third.id, second.id]);
    expect(posts[0]!.activeId).toBe(replies.at(-1)!.id);
    expect(posts[0]!.message.thread).toMatchObject({ count: 3 });
    // Only the newest replies, oldest first.
    expect(posts[0]!.replies.map(({ id }) => id)).toEqual(replies.slice(-POST_REPLIES_SHOWN).map(({ id }) => id));
    expect(posts[1]).toEqual({ message: third, replies: [], activeId: third.id });
  });

  it("pages back by activity, and lists a post whose message was deleted while its thread has replies", async () => {
    const room = await freshRoom("posts-paging");
    const ada = await connect(room, "Ada");
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await post(ada, `<p>Post ${i}</p>`));
    await reply(ada, made[0]!, "<p>Bump</p>");
    ada.send({ type: "message.delete", messageId: made[0]!.id });
    await ada.next("message.updated");

    const page = await postsOf(ada, undefined, 2);
    expect(page.hasMore).toBe(true);
    expect(page.posts.map(({ message }) => message.id)).toEqual([made[0]!.id, made[4]!.id]);
    expect(page.posts[0]!.message.deleted).toBe(true);

    const next = await postsOf(ada, page.posts.at(-1)!.activeId, 2);
    expect(next.before).toBe(made[4]!.id);
    expect(next.posts.map(({ message }) => message.id)).toEqual([made[3]!.id, made[2]!.id]);
    const last = await postsOf(ada, next.posts.at(-1)!.activeId, 2);
    expect(last).toMatchObject({ hasMore: false });
    expect(last.posts.map(({ message }) => message.id)).toEqual([made[1]!.id]);
  });

  it("answers an empty room with no posts", async () => {
    const ada = await connect(await freshRoom("posts-empty"), "Ada");
    expect(await postsOf(ada)).toEqual({ type: "posts", before: null, posts: [], hasMore: false });
  });
});

describe("Comments and their replies", () => {
  it("replies to a comment under it, and to a reply beside it, two levels and no deeper, counting them", async () => {
    const room = await freshRoom("comment-replies");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const post = await post_(ada, "<p>Who has the best pizza?</p>");
    const comment = await reply(grace, post, "<p>New York</p>");
    const first = await answer(ada, post, comment.id, "<p>Why?</p>");
    expect(first).toMatchObject({ parentId: post.id, replyToId: comment.id });
    expect((await updated(ada, comment.id)).replyCount).toBe(1);
    // A reply to that reply stacks under the same comment.
    const second = await answer(grace, post, first.id, "<p>Because</p>");
    expect(second.replyToId).toBe(comment.id);
    expect((await updated(ada, comment.id)).replyCount).toBe(2);

    const { posts } = await postsOf(ada);
    // The post's preview shows its comments, not the replies to them, and its thread counts every reply.
    expect(posts[0]!.replies.map(({ id }) => id)).toEqual([comment.id]);
    expect(posts[0]!.replies[0]!.replyCount).toBe(2);
    expect(posts[0]!.message.thread?.count).toBe(3);
    expect(posts[0]!.activeId).toBe(second.id);

    ada.send({ type: "replies.after", commentId: comment.id });
    expect(await ada.next("replies")).toMatchObject({ commentId: comment.id, after: null, hasMore: false, replies: [{ id: first.id }, { id: second.id }] });
  });

  it("pages a post's comments newest first and a comment's replies oldest first", async () => {
    const room = await freshRoom("comment-pages");
    const ada = await connect(room, "Ada");
    const post = await post_(ada, "<p>Toppings?</p>");
    const comments = [];
    for (let i = 0; i < 4; i++) comments.push(await reply(ada, post, `<p>Comment ${i}</p>`));
    const replies = [];
    for (let i = 0; i < COMMENT_REPLIES_PAGE_SIZE + 1; i++) replies.push(await answer(ada, post, comments[0]!.id, `<p>Reply ${i}</p>`));

    ada.send({ type: "comments.before", parentId: post.id, limit: 3 });
    const newest = await ada.next("comments");
    expect(newest.comments.map(({ id }) => id)).toEqual([comments[3]!.id, comments[2]!.id, comments[1]!.id]);
    expect(newest.hasMore).toBe(true);
    ada.send({ type: "comments.before", parentId: post.id, before: comments[1]!.id, limit: 3 });
    expect(await ada.next("comments")).toMatchObject({ before: comments[1]!.id, hasMore: false, comments: [{ id: comments[0]!.id, replyCount: COMMENT_REPLIES_PAGE_SIZE + 1 }] });

    ada.send({ type: "replies.after", commentId: comments[0]!.id });
    const oldest = await ada.next("replies");
    expect(oldest.replies.map(({ id }) => id)).toEqual(replies.slice(0, COMMENT_REPLIES_PAGE_SIZE).map(({ id }) => id));
    expect(oldest.hasMore).toBe(true);
    ada.send({ type: "replies.after", commentId: comments[0]!.id, after: oldest.replies.at(-1)!.id });
    expect((await ada.next("replies")).replies.map(({ id }) => id)).toEqual([replies.at(-1)!.id]);
  });

  it("deletes a comment's replies with it, and counts a comment's replies again as one goes", async () => {
    const room = await freshRoom("comment-deletes");
    const ada = await connect(room, "Ada");
    const post = await post_(ada, "<p>Crust</p>");
    const [kept, doomed] = [await reply(ada, post, "<p>Thin</p>"), await reply(ada, post, "<p>Thick</p>")];
    const [a, b] = [await answer(ada, post, kept.id, "<p>Yes</p>"), await answer(ada, post, kept.id, "<p>No</p>")];
    const orphan = await answer(ada, post, doomed.id, "<p>Maybe</p>");

    ada.send({ type: "message.delete", messageId: a.id });
    expect(await ada.next("message.deleted")).toMatchObject({ messageId: a.id });
    expect((await updated(ada, kept.id)).replyCount).toBe(1);

    ada.send({ type: "message.delete", messageId: doomed.id });
    const gone = [(await ada.next("message.deleted")).messageId, (await ada.next("message.deleted")).messageId];
    expect(gone.sort()).toEqual([doomed.id, orphan.id].sort());
    ada.send({ type: "comments.before", parentId: post.id });
    expect((await ada.next("comments")).comments.map(({ id }) => id)).toEqual([kept.id]);
    ada.send({ type: "replies.after", commentId: kept.id });
    expect((await ada.next("replies")).replies.map(({ id }) => id)).toEqual([b.id]);
  });

  it("refuses a reply to a comment in another thread, and opens a post on its own", async () => {
    const room = await freshRoom("comment-refusals");
    const ada = await connect(room, "Ada");
    const [one, two] = [await post_(ada, "<p>One</p>"), await post_(ada, "<p>Two</p>")];
    const comment = await reply(ada, one, "<p>On one</p>");
    ada.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>Lost</p>", parentId: two.id, replyToId: comment.id });
    expect(await ada.next("error")).toMatchObject({ failed: "message.create" });

    ada.send({ type: "post.open", postId: one.id });
    expect(await ada.next("post")).toMatchObject({ postId: one.id, post: { message: { id: one.id }, replies: [{ id: comment.id }], activeId: comment.id } });
    ada.send({ type: "post.open", postId: comment.id });
    expect(await ada.next("post")).toEqual({ type: "post", postId: comment.id, post: null });
  });
});

describe("Posts rooms where only admins start posts", () => {
  it("refuses a post from anyone but its admins and creator, who all comment and reply", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const news = await createRoom("News", { posts: true, postsByAdmins: true, as: ada });
    expect(news).toMatchObject({ posts: true, postsByAdmins: true });
    const [adaSocket, graceSocket] = [await connect(news.id, ada), await connect(news.id, grace)];

    const announcement = await post_(adaSocket, "<p>Version 3 is out</p>");
    graceSocket.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body: "<p>My own post</p>" });
    expect(await graceSocket.next("error")).toMatchObject({ message: "Only admins start posts here. You can comment on them.", failed: "message.create" });
    expect(await workspaceSql("SELECT count(*) AS n FROM rooms WHERE id = ? AND posts_by_admins = 1", news.id)).toEqual([{ n: 1 }]);
    const comment = await reply(graceSocket, announcement, "<p>Congrats!</p>");
    expect(comment.parentId).toBe(announcement.id);

    const upload = await startUpload(grace, news.id, { name: "notes.txt", type: "text/plain", size: 5, clientMessageId: crypto.randomUUID() });
    expect(upload.status).toBe(422);

    // An administrator starts posts there too, as the Workspace says when they next connect.
    await workspaceSql("UPDATE users SET role = 1 WHERE id = ?", grace.user.id);
    const promoted = await connect(news.id, grace);
    expect((await post_(promoted, "<p>From an admin</p>")).plainText).toBe("From an admin");
  });

  it("lets anyone post again once the setting's off, and keeps it only for a posts room", async () => {
    const [ada, grace] = [await signIn("Ada"), await signIn("Grace")];
    const news = await createRoom("News", { posts: true, postsByAdmins: true, as: ada });
    const changed = ((await (await change(news.id, ada, { postsByAdmins: false })).json()) as { room: SharedRoom }).room;
    expect(changed).not.toHaveProperty("postsByAdmins");
    const graceSocket = await connect(news.id, grace);
    expect((await post_(graceSocket, "<p>Anyone posts</p>")).plainText).toBe("Anyone posts");

    const chat = await createRoom("Chat", { postsByAdmins: true, as: ada });
    expect(chat).not.toHaveProperty("postsByAdmins");
    expect(((await (await change(news.id, ada, { postsByAdmins: true, posts: false })).json()) as { room: SharedRoom }).room).not.toHaveProperty("postsByAdmins");
  });
});

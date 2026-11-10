import { POST_REPLIES_SHOWN, type Message, type RoomId, type RoomSettings, type SharedRoom, type Sidebar } from "@ember/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { api, connect, createRoom, freshDeploy, freshRoom, post, signIn, workspaceSql, type Session, type Socket } from "./support";

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

import { POST_REPLIES_SHOWN, type Message, type Post, type ServerFrame } from "@ember/protocol";

/**
 * A posts room's posts as its feed shows them, newest activity first, which the room's frames keep up
 * to date: a new post goes to the top, and a reply goes under its post, which comes to the top with it.
 */
export interface PostsState {
  posts: Post[];
  /** Whether the room has posts older than the oldest shown. */
  hasMore: boolean;
  /** Whether a page has been asked for and hasn't come. */
  loading: boolean;
  /** Whether the first page has come. */
  loaded: boolean;
  /** Whether a reply came to a post the feed doesn't have, which asking for the newest page brings. */
  stale: boolean;
  /**
   * Whether posts have had activity that would move them up, which waits for the reader to ask, so a card
   * never moves while someone is reading or writing in it.
   */
  moved: boolean;
}

export type PostsAction = { type: "frame"; frame: ServerFrame } | { type: "loading" } | { type: "reorder" };

export const initialPostsState: PostsState = { posts: [], hasMore: false, loading: false, loaded: false, stale: false, moved: false };

/** Posts newest activity first, as the room orders them. */
const byActivity = (posts: Post[]) => posts.sort((a, b) => (a.activeId < b.activeId ? 1 : a.activeId > b.activeId ? -1 : 0));

/** `posts` with `change` made to the message `id`, wherever it shows: as a post, or one of its replies. */
function changed(posts: Post[], id: string, change: (message: Message) => Message): Post[] {
  return posts.map((post) => {
    if (post.message.id === id) return { ...post, message: change(post.message) };
    if (!post.replies.some((reply) => reply.id === id)) return post;
    return { ...post, replies: post.replies.map((reply) => (reply.id === id ? change(reply) : reply)) };
  });
}

/** The feed with `message` in it: a new post, or a reply under its post, which it brings to the top. */
function received(state: PostsState, message: Message): PostsState {
  const { parentId } = message;
  if (parentId === undefined) {
    if (state.posts.some((post) => post.message.id === message.id)) return state;
    return { ...state, posts: byActivity([{ message, replies: [], activeId: message.id }, ...state.posts]) };
  }
  const post = state.posts.find((post) => post.message.id === parentId);
  if (!post) return { ...state, stale: true };
  const comment = message.replyToId === undefined;
  const replies = comment ? [...post.replies.filter((reply) => reply.id !== message.id), message].slice(-POST_REPLIES_SHOWN) : post.replies;
  const activeId = message.id > post.activeId ? message.id : post.activeId;
  const posts = state.posts.map((p) => (p === post ? { ...post, replies, activeId } : p));
  // It goes up once the reader asks, unless it's on top already.
  return { ...state, posts, moved: state.moved || state.posts[0] !== post };
}

/** The feed with a page of posts: the newest in place of what it showed, or older ones after it. */
function paged(state: PostsState, { before, posts, hasMore }: Extract<ServerFrame, { type: "posts" }>): PostsState {
  if (before === null) return { posts, hasMore, loading: false, loaded: true, stale: false, moved: false };
  const shown = new Set(state.posts.map((post) => post.message.id));
  return { ...state, posts: [...state.posts, ...posts.filter((post) => !shown.has(post.message.id))], hasMore, loading: false };
}

export function postsReducer(state: PostsState, action: PostsAction): PostsState {
  if (action.type === "loading") return { ...state, loading: true };
  if (action.type === "reorder") return { ...state, posts: byActivity([...state.posts]), moved: false };
  const { frame } = action;
  switch (frame.type) {
    case "posts":
      return paged(state, frame);
    case "post":
      return { posts: frame.post ? [frame.post] : [], hasMore: false, loading: false, loaded: true, stale: false, moved: false };
    case "message.created":
      return received(state, frame.message);
    case "message.updated":
      return { ...state, posts: changed(state.posts, frame.message.id, () => frame.message) };
    case "message.deleted":
      return {
        ...state,
        posts: state.posts
          .filter((post) => post.message.id !== frame.messageId)
          .map((post) => (post.replies.some((reply) => reply.id === frame.messageId) ? { ...post, replies: post.replies.filter((reply) => reply.id !== frame.messageId) } : post)),
      };
    case "boost.created":
      return { ...state, posts: changed(state.posts, frame.boost.messageId, (m) => ({ ...m, boosts: [...m.boosts.filter((b) => b.id !== frame.boost.id), frame.boost] })) };
    case "boost.deleted":
      return { ...state, posts: changed(state.posts, frame.messageId, (m) => ({ ...m, boosts: m.boosts.filter((b) => b.id !== frame.boostId) })) };
    default:
      return state;
  }
}

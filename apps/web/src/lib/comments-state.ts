import { POST_REPLIES_SHOWN, type Message, type ServerFrame, type UserId } from "@ember/protocol";

/** A comment's replies as its post's card shows them, oldest first. */
export interface RepliesState {
  replies: Message[];
  /** Whether there are replies after the last one shown. */
  hasMore: boolean;
  loading: boolean;
  /** Whether the reader has opened them, or replied, which shows them. */
  open: boolean;
}

/**
 * One post's comments, as its card shows them: the comments it knows, oldest first, whether the reader has
 * asked for more than the newest few, and each comment's replies. Comments others write while the card is
 * on screen wait, unseen, until the reader shows them, so nothing moves under someone reading; their own
 * show at once.
 */
export interface CommentsState {
  postId: string;
  comments: Message[];
  /** Whether the reader has asked for more than the newest comments, which shows every comment it knows. */
  expanded: boolean;
  /** Whether there are older comments to load: null until a page has said, when the counts tell. */
  hasOlder: boolean | null;
  loadingOlder: boolean;
  /** The comments others wrote since the card showed, by id, until the reader shows them. */
  unseen: string[];
  replies: Record<string, RepliesState>;
}

export type CommentsAction =
  | { type: "frame"; frame: ServerFrame; me: UserId }
  | { type: "loading-older" }
  | { type: "loading-replies"; commentId: string }
  | { type: "show-unseen" }
  | { type: "expand" };

export const initialCommentsState = (postId: string, preview: Message[], expanded = false): CommentsState => ({
  postId,
  comments: [...preview].sort(byId),
  expanded,
  hasOlder: null,
  loadingOlder: false,
  unseen: [],
  replies: {},
});

const byId = (a: Message, b: Message) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `messages` with `added` in them, once each, oldest first. */
function merged(messages: Message[], added: Message[]): Message[] {
  const known = new Map(messages.map((m) => [m.id, m]));
  for (const message of added) known.set(message.id, message);
  return [...known.values()].sort(byId);
}

const NO_REPLIES: RepliesState = { replies: [], hasMore: false, loading: false, open: false };

/** `state` with `change` made to the message `id`, as a comment or a reply. */
function changed(state: CommentsState, id: string, change: (message: Message) => Message): CommentsState {
  const replies = Object.fromEntries(
    Object.entries(state.replies).map(([commentId, shown]) => [commentId, { ...shown, replies: shown.replies.map((m) => (m.id === id ? change(m) : m)) }]),
  );
  return { ...state, comments: state.comments.map((m) => (m.id === id ? change(m) : m)), replies };
}

function received(state: CommentsState, message: Message, me: UserId): CommentsState {
  if (message.parentId !== state.postId) return state;
  const mine = message.creator.id === me;
  if (message.replyToId === undefined) {
    if (state.comments.some((m) => m.id === message.id)) return state;
    return { ...state, comments: merged(state.comments, [message]), unseen: mine ? state.unseen : [...state.unseen, message.id] };
  }
  // A reply shows where its comment's replies are open, and your own opens them.
  const shown = state.replies[message.replyToId] ?? NO_REPLIES;
  if (!shown.open && !mine) return state;
  return { ...state, replies: { ...state.replies, [message.replyToId]: { ...shown, open: true, replies: merged(shown.replies, [message]) } } };
}

export function commentsReducer(state: CommentsState, action: CommentsAction): CommentsState {
  switch (action.type) {
    case "loading-older":
      return { ...state, loadingOlder: true };
    case "loading-replies": {
      const shown = state.replies[action.commentId] ?? NO_REPLIES;
      return { ...state, replies: { ...state.replies, [action.commentId]: { ...shown, loading: true } } };
    }
    case "show-unseen":
      return { ...state, unseen: [] };
    case "expand":
      return { ...state, expanded: true };
    case "frame":
      break;
  }
  const { frame, me } = action;
  switch (frame.type) {
    case "comments":
      if (frame.parentId !== state.postId) return state;
      return { ...state, comments: merged(state.comments, frame.comments), expanded: true, hasOlder: frame.hasMore, loadingOlder: false };
    case "replies": {
      if (!state.comments.some((m) => m.id === frame.commentId)) return state;
      const shown = state.replies[frame.commentId] ?? NO_REPLIES;
      const replies = { ...shown, replies: merged(shown.replies, frame.replies), hasMore: frame.hasMore, loading: false, open: true };
      return { ...state, replies: { ...state.replies, [frame.commentId]: replies } };
    }
    case "message.created":
      return received(state, frame.message, me);
    case "message.updated":
      return changed(state, frame.message.id, () => frame.message);
    case "message.deleted": {
      const gone = frame.messageId;
      const replies = Object.fromEntries(Object.entries(state.replies).map(([id, shown]) => [id, { ...shown, replies: shown.replies.filter((m) => m.id !== gone) }]));
      return { ...state, comments: state.comments.filter((m) => m.id !== gone), unseen: state.unseen.filter((id) => id !== gone), replies };
    }
    case "boost.created":
      return changed(state, frame.boost.messageId, (m) => ({ ...m, boosts: [...m.boosts.filter((b) => b.id !== frame.boost.id), frame.boost] }));
    case "boost.deleted":
      return changed(state, frame.messageId, (m) => ({ ...m, boosts: m.boosts.filter((b) => b.id !== frame.boostId) }));
    default:
      return state;
  }
}

/** The comments a card shows, oldest first: every one it knows once expanded, or else the newest few, leaving out those still unseen. */
export function shownComments(state: CommentsState): Message[] {
  const seen = state.comments.filter((m) => !state.unseen.includes(m.id));
  return state.expanded ? seen : seen.slice(-POST_REPLIES_SHOWN);
}

/**
 * Whether the post has comments older than those shown: as a page said, or, before one has, whether its
 * thread has more replies than the comments known and their replies.
 */
export function hasOlderComments(state: CommentsState, threadCount: number): boolean {
  if (!state.expanded && state.comments.length - state.unseen.length > POST_REPLIES_SHOWN) return true;
  if (state.hasOlder !== null) return state.hasOlder;
  const known = state.comments.reduce((sum, m) => sum + 1 + (m.replyCount ?? 0), 0);
  return threadCount > known;
}

import { useContext, useEffect, useRef, useState } from "react";
import type { Me, Message, Post, User } from "@ember/protocol";
import { editableBody, MENTION_CONTENT_TYPE, mentionSgid, writtenBody } from "@ember/richtext/dom";
import { ChatBubbleEmpty, NavArrowDown, NavArrowRight, Sort } from "@/components/icons/iconoir";
import { useComments } from "@/hooks/use-comments";
import { PeopleContext, type People } from "@/hooks/use-directory";
import { isTooLong, type RoomFrames } from "@/hooks/use-room";
import { hasOlderComments, shownComments, type CommentsState } from "@/lib/comments-state";
import { uploadFile } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import { Composer, type ComposerHandle } from "./composer";
import { MessageItem, repliesLabel, type MessageActions, type MessageEditors, type ThreadPlace } from "./message-item";
import { avatarUrlOf, UserAvatar } from "./user-avatar";

/** Which comments come first in a card: the newest, or the oldest. Replies to a comment always read oldest first. */
export type CommentOrder = "newest" | "oldest";

/** Where the order a reader last chose is remembered, for the cards they open next. */
const ORDER_KEY = "ember-posts-comment-order";

/** The order a reader last chose for a card's comments, or the newest first. */
export function rememberedOrder(): CommentOrder {
  try {
    return localStorage.getItem(ORDER_KEY) === "oldest" ? "oldest" : "newest";
  } catch {
    return "newest";
  }
}

function rememberOrder(order: CommentOrder) {
  try {
    localStorage.setItem(ORDER_KEY, order);
  } catch {
    // A browser that keeps nothing still sorts this card.
  }
}

/** Where a reply box is open: under a comment's replies, or under the reply it answers, with whom it's to. */
interface Replying {
  commentId: string;
  /** The reply it answers, which it opens under, mentioning its writer; none for a reply to the comment. */
  reply?: Message;
}

interface Props {
  post: Post;
  roomName: string;
  frames: RoomFrames;
  me: Me;
  actions: MessageActions | null;
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  /** Whether the post is open on its own, as its permalink shows it, with its comments loaded from the start. */
  alone?: boolean;
  /** The comment to go to and mark, as a comment's permalink opens the post. */
  focusId?: string;
  /** Whether the room has gone, which leaves the post as it is, with nowhere to comment. */
  closed: boolean;
}

/**
 * A post in a posts room, as a Facebook group shows one, without a dialog: the post, how many comments it
 * has, its newest comments, and a comment box, all in the card. View more comments brings older ones a few at
 * a time, in the order the reader picks, and each comment's replies open in place, oldest first, two levels
 * deep: a reply to a reply goes beside it, mentioning whom it answers.
 */
export function PostCard({ post, roomName, frames, me, actions, editing, editors, alone = false, focusId, closed }: Props) {
  const { message } = post;
  const comments = useComments(frames, message.id, post.replies, me.id, alone);
  const [order, setOrder] = useState<CommentOrder>(rememberedOrder);
  const [replying, setReplying] = useState<Replying | null>(null);
  const place: ThreadPlace = { roomName, direct: false };
  const count = message.thread?.count ?? 0;
  const shown = shownComments(comments.state);
  const ordered = order === "newest" ? [...shown].reverse() : shown;
  const older = hasOlderComments(comments.state, count);
  const unseen = comments.state.unseen.length;
  // Sorting a card's few newest comments changes nothing, so the order shows once there are more.
  const sortable = alone || comments.state.expanded || older;

  const flip = () => {
    const next = order === "newest" ? "oldest" : "newest";
    setOrder(next);
    rememberOrder(next);
  };

  const viewOlder = (
    <button type="button" onClick={comments.loadOlder} disabled={comments.state.loadingOlder} className={LINK}>
      {comments.state.loadingOlder ? "Loading comments…" : order === "newest" ? "View more comments" : "View previous comments"}
    </button>
  );
  const showNew = unseen > 0 && (
    <button type="button" onClick={comments.showUnseen} className={cn(LINK, "text-link")}>
      Show {unseen === 1 ? "1 new comment" : `${unseen} new comments`}
    </button>
  );
  const box = !closed && <CommentBox roomId={message.roomId} postId={message.id} me={me} frames={frames} autoFocus={false} />;

  return (
    <article aria-label={`Post by ${message.creator.name}`} className={CARD}>
      <MessageItem message={message} me={me} threaded={false} editing={editing.has(message.id)} actions={actions} editors={editors} post />

      <div className="mx-5 mt-1 flex items-center gap-3 border-t pt-2 text-[13px] text-message-muted max-md:mx-3">
        <span className="flex items-center gap-1.5">
          <ChatBubbleEmpty aria-hidden className="size-4" />
          {count === 0 ? "No comments yet" : count === 1 ? "1 comment" : `${count} comments`}
        </span>
        {sortable && (
          <button
            type="button"
            onClick={flip}
            aria-label={order === "newest" ? "Newest comments first. Show the oldest first" : "Oldest comments first. Show the newest first"}
            className="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold hover:bg-hover touch:min-h-11"
          >
            <Sort aria-hidden className="size-4" />
            {order === "newest" ? "Newest first" : "Oldest first"}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1 pt-1">
        {/* New comments land where the order puts them, beside the box that writes them. */}
        {order === "newest" && box}
        {order === "newest" ? showNew : older && viewOlder}
        {ordered.map((comment) => (
          <Comment
            key={comment.id}
            comment={comment}
            state={comments.state}
            me={me}
            actions={actions}
            editing={editing}
            editors={editors}
            place={place}
            replying={replying?.commentId === comment.id ? replying : null}
            onReply={(reply) => {
              setReplying({ commentId: comment.id, reply });
              if (!comments.state.replies[comment.id]?.open && (comment.replyCount ?? 0) > 0) comments.loadReplies(comment.id);
            }}
            onCloseReply={() => setReplying(null)}
            // Once sent, the box goes to the end of the comment's replies, under the new one, for the next.
            onSent={() => setReplying({ commentId: comment.id })}
            onLoadReplies={() => comments.loadReplies(comment.id)}
            frames={frames}
            postId={message.id}
            focused={comment.id === focusId}
            closed={closed}
          />
        ))}
        {order === "newest" ? older && viewOlder : showNew}
        {order === "oldest" && box}
      </div>
    </article>
  );
}

/** A post's card. */
const CARD = "rounded-[10px] border bg-surface pt-2 pb-3";
/** A link-like button in a card, as View more comments. */
const LINK = "mx-5 self-start text-[13px] font-semibold text-message-muted hover:underline disabled:opacity-60 max-md:mx-3 touch:min-h-11";
/** Where a comment's replies go: indented under it, with a guide line, once only, however deep the conversation. */
const REPLIES = "ml-[64px] border-l-2 pl-1 max-md:ml-[44px]";

interface CommentProps {
  comment: Message;
  state: CommentsState;
  me: Me;
  actions: MessageActions | null;
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  place: ThreadPlace;
  replying: Replying | null;
  onReply: (reply?: Message) => void;
  onCloseReply: () => void;
  onSent: () => void;
  onLoadReplies: () => void;
  frames: RoomFrames;
  postId: string;
  focused: boolean;
  closed: boolean;
}

/** A comment, Reply under it, and its replies, opened in place, oldest first, with a reply box where the reader replies. */
function Comment({ comment, state, me, actions, editing, editors, place, replying, onReply, onCloseReply, onSent, onLoadReplies, frames, postId, focused, closed }: CommentProps) {
  const row = useRef<HTMLDivElement>(null);
  const replies = state.replies[comment.id];
  const shownReplies = replies?.open ? replies.replies : [];
  const count = comment.replyCount ?? 0;
  const hidden = Math.max(0, count - shownReplies.length);

  useEffect(() => {
    if (focused) row.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);

  const box = (reply?: Message) =>
    replying && replying.reply?.id === reply?.id && !closed ? (
      <ReplyBox roomId={comment.roomId} postId={postId} commentId={comment.id} to={reply?.creator} me={me} frames={frames} onClose={onCloseReply} onSent={onSent} />
    ) : null;

  return (
    <div ref={row} data-comment-id={comment.id} className={cn(focused && "bg-mention/10")}>
      <MessageItem message={comment} me={me} threaded={false} editing={editing.has(comment.id)} actions={actions} editors={editors} thread={place} />
      {!comment.deleted && !closed && <ReplyLink onClick={() => onReply()} />}

      {(shownReplies.length > 0 || hidden > 0 || replying) && (
        <div className={REPLIES}>
          {shownReplies.map((reply) => (
            <div key={reply.id} data-comment-id={reply.id}>
              <MessageItem message={reply} me={me} threaded={false} editing={editing.has(reply.id)} actions={actions} editors={editors} thread={place} />
              {!closed && <ReplyLink onClick={() => onReply(reply)} />}
              {box(reply)}
            </div>
          ))}
          {hidden > 0 && (
            <button type="button" onClick={onLoadReplies} disabled={replies?.loading} className={cn(LINK, "mx-3 flex items-center gap-1.5")}>
              {replies?.open ? <NavArrowDown aria-hidden className="size-4" /> : <NavArrowRight aria-hidden className="size-4" />}
              {replies?.loading ? "Loading replies…" : replies?.open ? `View ${hidden === 1 ? "1 more reply" : `${hidden} more replies`}` : `View ${repliesLabel(count)}`}
            </button>
          )}
          {box(undefined)}
        </div>
      )}
    </div>
  );
}

/** Reply, under a comment or a reply, lined up with its text. */
function ReplyLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 ml-[64px] text-[12px] font-semibold text-message-muted hover:underline max-md:ml-[52px] touch:min-h-11"
    >
      Reply
    </button>
  );
}

/** What a reply box writes before anything else: a mention of whom it answers, as the editor shows mentions. */
function mentionMarkup(person: User, people: People): string {
  const stored = `<p><action-text-attachment sgid="${mentionSgid(person.id)}" content-type="${MENTION_CONTENT_TYPE}"></action-text-attachment>&nbsp;</p>`;
  return editableBody(stored, (userId) => (userId === person.id ? { id: person.id, name: person.name, avatarUrl: avatarUrlOf(people, person) } : undefined), location.hostname);
}

/** Sends `body` as a comment on `postId`, or a reply to `replyToId`, answering whether it went. */
function sendComment(frames: RoomFrames, postId: string, body: string, replyToId?: string): boolean {
  if (isTooLong(body, writtenBody(body).plainText)) return false;
  return frames.send({ type: "message.create", clientMessageId: crypto.randomUUID(), body, parentId: postId, ...(replyToId !== undefined && { replyToId }) });
}

/**
 * The box that comments on a post: a line that says what it's for, which becomes the editor as it's
 * pressed, so a feed of cards doesn't load an editor for each.
 */
function CommentBox({ roomId, postId, me, frames, autoFocus }: { roomId: string; postId: string; me: Me; frames: RoomFrames; autoFocus: boolean }) {
  const [open, setOpen] = useState(autoFocus);
  if (!open)
    return (
      <div className="mx-5 flex items-center gap-2 py-1 max-md:mx-3">
        <UserAvatar user={me} className="size-8 flex-none rounded-full" />
        {/* It looks and reads as the field it becomes, so it has a text cursor. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="min-h-9 flex-1 cursor-text rounded-full border bg-background px-3.5 text-start text-sm text-muted-foreground hover:border-message-border touch:min-h-11"
        >
          Write a comment…
        </button>
      </div>
    );
  return (
    <div className="px-2">
      <Composer
        roomId={roomId}
        roomName=""
        userId={me.id}
        typing={[]}
        disabled={false}
        threadId={postId}
        posts
        placeholder="Write a comment…"
        onSend={(body) => sendComment(frames, postId, body)}
        onSendFiles={(files) => {
          for (const file of files) void uploadFile(roomId, file, crypto.randomUUID(), () => {}, { parentId: postId, alsoSend: false }).catch(() => {});
        }}
        onTyping={() => {}}
        autoFocus
      />
    </div>
  );
}

/** A reply box, open under the comment or reply it answers, saying whom it replies to; Escape closes it, keeping what's written. */
function ReplyBox({ roomId, postId, commentId, to, me, frames, onClose, onSent }: { roomId: string; postId: string; commentId: string; to?: User; me: Me; frames: RoomFrames; onClose: () => void; onSent: () => void }) {
  const composer = useRef<ComposerHandle>(null);
  const people = useContext(PeopleContext);
  const mention = to && to.id !== me.id ? to : undefined;
  // The mention goes in as the box opens, before anything's written.
  useEffect(() => {
    if (mention) composer.current?.replace(mentionMarkup(mention, people));
  }, [mention?.id]);
  return (
    <div className="px-1 pb-1" onKeyDown={(event) => event.key === "Escape" && onClose()}>
      {mention && <p className="mx-3 mt-1 text-[12px] text-message-muted">Replying to {mention.name}</p>}
      <Composer
        ref={composer}
        roomId={roomId}
        roomName=""
        userId={me.id}
        typing={[]}
        disabled={false}
        threadId={`${postId}/${commentId}`}
        posts
        files={false}
        placeholder={mention ? `Reply to ${mention.name}…` : "Write a reply…"}
        onSend={(body) => {
          const sent = sendComment(frames, postId, body, commentId);
          if (sent) onSent();
          return sent;
        }}
        onSendFiles={() => {}}
        onTyping={() => {}}
        autoFocus
      />
    </div>
  );
}

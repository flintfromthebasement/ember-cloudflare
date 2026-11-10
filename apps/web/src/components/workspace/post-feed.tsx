import { useEffect, useRef } from "react";
import { threadPath, type Me, type Post } from "@ember/protocol";
import { PageLink } from "@/components/page-link";
import { RefusedUnboosts, RoomConnection, type RoomFrames } from "@/hooks/use-room";
import { usePosts } from "@/hooks/use-posts";
import { isPending, type RoomState } from "@/lib/room-state";
import { cn } from "@/lib/utils";
import { MessageItem, repliesLabel, type MessageActions, type MessageEditors, type ThreadPlace } from "./message-item";

/** How near the end of the feed the reader can come before its next page loads. */
const PAGE_AHEAD_PX = 400;

interface Props {
  roomName: string;
  /** The room's socket, which the feed's posts come over. */
  frames: RoomFrames;
  /** The room's timeline, for the posts on their way to the room and its connection. */
  state: RoomState;
  me: Me;
  /** What can be done to the posts and replies, or null for a room that's gone. */
  actions: MessageActions | null;
  /** The posts whose editors are open. */
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  /** The post whose thread is open beside the room. */
  openThread?: string;
}

/**
 * A posts room's feed, as a community's forum shows it: each post a card, newest activity first, with
 * its newest replies under it, View all replies when it has more, and a reply box that opens its thread.
 * Posts on their way to the room show above the rest.
 */
export function PostFeed({ roomName, frames, state, me, actions, editing, editors, openThread }: Props) {
  const { state: feed, loadOlder } = usePosts(frames);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const place: ThreadPlace = { roomName, direct: false };
  const sending = state.messages.filter((message) => isPending(message) && message.parentId === undefined);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => entries.at(-1)?.isIntersecting && loadOlder(), {
      root: scroller.current,
      rootMargin: `0px 0px ${PAGE_AHEAD_PX}px 0px`,
    });
    observer.observe(end.current!);
    return () => observer.disconnect();
  }, [loadOlder]);

  return (
    <div ref={scroller} role="feed" aria-label={`Posts in ${roomName}`} aria-busy={feed.loading || undefined} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable] max-md:px-3">
      <RoomConnection value={state.connections}>
        <RefusedUnboosts value={state.refusedUnboosts}>
          <div className="mx-auto flex max-w-[760px] flex-col gap-4">
            {sending.map((message) => (
              <article key={`${message.creator.id}:${message.clientMessageId}`} className={CARD}>
                <MessageItem message={message} me={me} threaded={false} editing={false} actions={actions} editors={editors} post />
              </article>
            ))}

            {feed.posts.map((post) => (
              <PostCard key={post.message.id} post={post} me={me} actions={actions} editing={editing} editors={editors} place={place} open={post.message.id === openThread} />
            ))}

            {feed.loaded && feed.posts.length === 0 && sending.length === 0 && (
              <div className="p-6 text-center text-muted-foreground">
                <h2 className="mb-1.5 text-xl text-foreground">Welcome to #{roomName}</h2>
                <p>Nobody has posted yet. Start the first post above.</p>
              </div>
            )}
            {feed.loading && <p className="py-2 text-center text-xs text-muted-foreground">Loading posts…</p>}
          </div>
          <div ref={end} aria-hidden className="h-px" />
        </RefusedUnboosts>
      </RoomConnection>
    </div>
  );
}

/** A post's card. */
const CARD = "overflow-hidden rounded-[10px] border bg-surface py-2";

interface PostCardProps {
  post: Post;
  me: Me;
  actions: MessageActions | null;
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  place: ThreadPlace;
  /** Whether its thread is open beside the room. */
  open: boolean;
}

/** One post: the message, then its newest replies, indented under it, and the way to reply. */
function PostCard({ post, me, actions, editing, editors, place, open }: PostCardProps) {
  const { message, replies } = post;
  const count = message.thread?.count ?? 0;
  const thread = threadPath(message.roomId, message.id);
  return (
    <article aria-label={`Post by ${message.creator.name}`} className={cn(CARD, open && "ring-2 ring-link/40")}>
      <MessageItem message={message} me={me} threaded={false} editing={editing.has(message.id)} actions={actions} editors={editors} post />

      {(count > 0 || replies.length > 0) && (
        <div className="mt-1 border-t pt-1">
          {count > replies.length && (
            <PageLink href={thread} className="mx-5 my-1 block text-[13px] font-semibold text-link no-underline hover:underline max-md:mx-3">
              View all {repliesLabel(count)}
            </PageLink>
          )}
          <div className="pl-6 max-md:pl-4">
            {replies.map((reply) => (
              <MessageItem key={reply.id} message={reply} me={me} threaded={false} editing={editing.has(reply.id)} actions={actions} editors={editors} thread={place} />
            ))}
          </div>
        </div>
      )}

      <PageLink
        href={thread}
        className="mx-5 mt-2 mb-1 block rounded-full border bg-background px-3.5 py-1.5 text-sm text-muted-foreground no-underline hover:border-message-border max-md:mx-3 touch:min-h-11 touch:py-2.5"
      >
        {count === 0 ? "Be the first to reply…" : "Write a reply…"}
      </PageLink>
    </article>
  );
}

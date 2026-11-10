import { useEffect, useRef } from "react";
import type { Me } from "@ember/protocol";
import { ArrowLeft, ArrowUp } from "@/components/icons/iconoir";
import { PageLink } from "@/components/page-link";
import { usePosts } from "@/hooks/use-posts";
import { roomPath } from "@/hooks/use-route";
import { RefusedUnboosts, RoomConnection, type RoomFrames } from "@/hooks/use-room";
import { isPending, type RoomState } from "@/lib/room-state";
import type { MessageActions, MessageEditors } from "./message-item";
import { MessageItem } from "./message-item";
import { PostCard } from "./post-card";

/** How near the end of the feed the reader can come before its next page loads. */
const PAGE_AHEAD_PX = 400;

interface Props {
  roomId: string;
  roomName: string;
  /** The room's socket, which the feed's posts come over. */
  frames: RoomFrames;
  /** The room's timeline, for the posts on their way to the room and its connection. */
  state: RoomState;
  me: Me;
  /** What can be done to the posts and comments, or null for a room that's gone. */
  actions: MessageActions | null;
  /** The posts whose editors are open. */
  editing: ReadonlySet<string>;
  editors: MessageEditors;
  /** The post to show on its own, as its permalink opens it, in place of the feed. */
  postId?: string;
  /** The comment to go to in that post. */
  commentId?: string;
  /** Whether the room has gone, which leaves its posts as they are. */
  closed: boolean;
}

/**
 * A posts room's feed, as a Facebook group shows one: each post a card, newest activity first, with its
 * comments in the card. Activity that would move a post up waits for New activity, so nothing moves under
 * a reader. Posts on their way to the room show above the rest. With `postId`, that post alone.
 */
export function PostFeed({ roomId, roomName, frames, state, me, actions, editing, editors, postId, commentId, closed }: Props) {
  const { state: feed, loadOlder, reorder } = usePosts(frames, postId);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const alone = postId !== undefined;
  const sending = alone ? [] : state.messages.filter((message) => isPending(message) && message.parentId === undefined);
  const posts = alone ? feed.posts.filter((post) => post.message.id === postId) : feed.posts;

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => entries.at(-1)?.isIntersecting && loadOlder(), {
      root: scroller.current,
      rootMargin: `0px 0px ${PAGE_AHEAD_PX}px 0px`,
    });
    observer.observe(end.current!);
    return () => observer.disconnect();
  }, [loadOlder]);

  const showActivity = () => {
    reorder();
    scroller.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  };

  return (
    <div ref={scroller} role="feed" aria-label={`Posts in ${roomName}`} aria-busy={feed.loading || undefined} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 [scrollbar-gutter:stable] max-md:px-3">
      {feed.moved && !alone && (
        <div className="sticky top-0 z-[2] flex justify-center">
          <button type="button" onClick={showActivity} className="flex items-center gap-1.5 rounded-full border bg-background px-3.5 py-1.5 text-sm font-semibold shadow-[0_3px_12px_#00000014] touch:min-h-11">
            <ArrowUp aria-hidden className="size-4" />
            New activity
          </button>
        </div>
      )}
      <RoomConnection value={state.connections}>
        <RefusedUnboosts value={state.refusedUnboosts}>
          <div className="mx-auto flex max-w-[760px] flex-col gap-4">
            {alone && (
              <PageLink href={roomPath(roomId)} className="flex items-center gap-1.5 self-start text-sm font-semibold text-link no-underline hover:underline">
                <ArrowLeft aria-hidden className="size-4" />
                All posts in #{roomName}
              </PageLink>
            )}

            {sending.map((message) => (
              <article key={`${message.creator.id}:${message.clientMessageId}`} className="overflow-hidden rounded-[10px] border bg-surface py-2">
                <MessageItem message={message} me={me} threaded={false} editing={false} actions={actions} editors={editors} post />
              </article>
            ))}

            {posts.map((post) => (
              <PostCard
                key={post.message.id}
                post={post}
                roomName={roomName}
                frames={frames}
                me={me}
                actions={actions}
                editing={editing}
                editors={editors}
                alone={alone}
                focusId={alone ? commentId : undefined}
                closed={closed}
              />
            ))}

            {feed.loaded && posts.length === 0 && sending.length === 0 && (
              <div className="p-6 text-center text-muted-foreground">
                {alone ? (
                  <p>This post was deleted, or isn't here.</p>
                ) : (
                  <>
                    <h2 className="mb-1.5 text-xl text-foreground">Welcome to #{roomName}</h2>
                    <p>Nobody has posted yet. Start the first post above.</p>
                  </>
                )}
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

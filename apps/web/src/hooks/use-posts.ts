import { useCallback, useEffect, useEffectEvent, useReducer } from "react";
import { POSTS_PAGE_SIZE } from "@ember/protocol";
import { initialPostsState, postsReducer } from "@/lib/posts-state";
import type { RoomFrames } from "./use-room";

/**
 * A posts room's feed over the room's socket, `frames`: its newest page of posts as it opens, again each
 * time the room lets the page in, and whenever a reply comes to a post it doesn't have, and the pages
 * before it as the reader asks for them. With `postId`, just that post, as its permalink opens it.
 */
export function usePosts(frames: RoomFrames, postId?: string) {
  const [state, dispatch] = useReducer(postsReducer, initialPostsState);
  const { send } = frames;

  const newest = useEffectEvent(() => {
    const asked = postId === undefined ? send({ type: "posts.before", limit: POSTS_PAGE_SIZE }) : send({ type: "post.open", postId });
    if (asked) dispatch({ type: "loading" });
  });

  useEffect(() => {
    const stop = frames.listen((frame) => {
      dispatch({ type: "frame", frame });
      if (frame.type === "welcome" || frame.type === "resumed") newest();
    });
    // Until the room lets the page in, its welcome asks.
    newest();
    return stop;
  }, [frames, postId]);

  useEffect(() => {
    if (state.stale && !state.loading && postId === undefined) newest();
  }, [state.stale, state.loading, postId]);

  const loadOlder = useCallback(() => {
    const before = state.posts.at(-1)?.activeId;
    if (before === undefined || !state.hasMore || state.loading || postId !== undefined) return;
    if (send({ type: "posts.before", before, limit: POSTS_PAGE_SIZE })) dispatch({ type: "loading" });
  }, [send, state.posts, state.hasMore, state.loading, postId]);

  const reorder = useCallback(() => dispatch({ type: "reorder" }), []);

  return { state, loadOlder, reorder };
}

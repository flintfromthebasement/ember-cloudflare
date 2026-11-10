import { useCallback, useEffect, useEffectEvent, useReducer } from "react";
import { POSTS_PAGE_SIZE } from "@ember/protocol";
import { initialPostsState, postsReducer } from "@/lib/posts-state";
import type { RoomFrames } from "./use-room";

/**
 * A posts room's feed over the room's socket, `frames`: its newest page of posts as it opens, again each
 * time the room lets the page in, and whenever a reply comes to a post it doesn't have, and the pages
 * before it as the reader asks for them.
 */
export function usePosts(frames: RoomFrames) {
  const [state, dispatch] = useReducer(postsReducer, initialPostsState);
  const { send } = frames;

  const newest = useEffectEvent(() => {
    if (send({ type: "posts.before", limit: POSTS_PAGE_SIZE })) dispatch({ type: "loading" });
  });

  useEffect(() => {
    const stop = frames.listen((frame) => {
      dispatch({ type: "frame", frame });
      if (frame.type === "welcome" || frame.type === "resumed") newest();
    });
    // Until the room lets the page in, its welcome asks.
    newest();
    return stop;
  }, [frames]);

  useEffect(() => {
    if (state.stale && !state.loading) newest();
  }, [state.stale, state.loading]);

  const loadOlder = useCallback(() => {
    const before = state.posts.at(-1)?.activeId;
    if (before === undefined || !state.hasMore || state.loading) return;
    if (send({ type: "posts.before", before, limit: POSTS_PAGE_SIZE })) dispatch({ type: "loading" });
  }, [send, state.posts, state.hasMore, state.loading]);

  return { state, loadOlder };
}

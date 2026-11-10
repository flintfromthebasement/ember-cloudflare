import { useCallback, useEffect, useReducer } from "react";
import { COMMENT_REPLIES_PAGE_SIZE, COMMENTS_PAGE_SIZE, type Message, type UserId } from "@ember/protocol";
import { commentsReducer, initialCommentsState, shownComments } from "@/lib/comments-state";
import type { RoomFrames } from "./use-room";

/**
 * One post's comments over its room's socket, `frames`, starting from the newest the feed sent with the
 * post, `preview`, and, for a post opened on its own, `expanded`, with every page of them the reader asks for.
 */
export function useComments(frames: RoomFrames, postId: string, preview: Message[], me: UserId, expanded = false) {
  const [state, dispatch] = useReducer(commentsReducer, undefined, () => initialCommentsState(postId, preview, expanded));
  const { send } = frames;

  useEffect(() => frames.listen((frame) => dispatch({ type: "frame", frame, me })), [frames, me]);

  const loadOlder = useCallback(() => {
    // Comments it knows but hasn't shown show first; the rest come a page at a time.
    if (!state.expanded && state.comments.length - state.unseen.length > shownComments(state).length) return dispatch({ type: "expand" });
    if (state.loadingOlder) return;
    const before = state.comments[0]?.id;
    if (send({ type: "comments.before", parentId: postId, ...(before !== undefined && { before }), limit: COMMENTS_PAGE_SIZE })) dispatch({ type: "loading-older" });
  }, [send, postId, state]);

  // A post opened on its own shows its comments from the start.
  useEffect(() => {
    if (expanded) send({ type: "comments.before", parentId: postId, limit: COMMENTS_PAGE_SIZE });
  }, [expanded, send, postId]);

  const loadReplies = useCallback(
    (commentId: string) => {
      const shown = state.replies[commentId];
      if (shown?.loading) return;
      const after = shown?.replies.at(-1)?.id;
      if (send({ type: "replies.after", commentId, ...(after !== undefined && { after }), limit: COMMENT_REPLIES_PAGE_SIZE })) dispatch({ type: "loading-replies", commentId });
    },
    [send, state.replies],
  );

  const showUnseen = useCallback(() => dispatch({ type: "show-unseen" }), []);

  return { state, loadOlder, loadReplies, showUnseen };
}

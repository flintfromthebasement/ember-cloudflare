import type { Message, ServerFrame } from "@ember/protocol";
import { OPENGRAPH_EMBED_CONTENT_TYPE } from "@ember/richtext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewAttachment } from "../src/assistant/answers";
import { connect, freshDeploy, freshRoom, origin, post, settle, type Socket } from "./support";

// The room previews a message's first link when the composer didn't, as Slack does after a message is sent:
// for a link typed rather than pasted, or sent before its preview came.

beforeEach(freshDeploy);

afterEach(() => {
  vi.restoreAllMocks();
});

/** A page with a preview, at http://www.example.com/. */
const PAGE =
  '<meta property="og:url" content="https://example.com/"><meta property="og:title" content="Example"><meta property="og:description" content="An example page."><meta property="og:image" content="https://example.com/card.png">';

/** Stands in for the Internet, where every name is at one public address and http://www.example.com/ has a preview. */
function internet() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname === "cloudflare-dns.com") return Response.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
    if (url.href === "http://www.example.com/") return new Response(PAGE, { headers: { "Content-Type": "text/html" } });
    if (url.href === "https://example.com/card.png") return new Response(null, { headers: { "Content-Type": "image/png" } });
    return new Response("not found", { status: 404 });
  });
}

/** The pages fetched since `internet` stood in for the Internet, but DNS lookups. */
const fetched = () =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)))
    .filter((url) => !url.includes("cloudflare-dns.com"));

/** The next change `client` hears to message `id`. */
async function updated(client: Socket, id: string): Promise<Extract<ServerFrame, { type: "message.updated" }>> {
  for (;;) {
    const frame = await client.next("message.updated");
    if (frame.message.id === id) return frame;
  }
}

const previewOf = (message: Message) => message.body.includes(OPENGRAPH_EMBED_CONTENT_TYPE);

describe("Previews the room adds", () => {
  it("previews the first link of a message sent without a preview, after it's sent, without marking it edited", async () => {
    internet();
    const room = await freshRoom("typed-link");
    const [ada, grace] = [await connect(room, "Ada"), await connect(room, "Grace")];
    const message = await post(ada, '<p>Read <a href="http://www.example.com/">http://www.example.com/</a> before Friday</p>');
    expect(previewOf(message)).toBe(false);

    const { message: previewed } = await updated(grace, message.id);
    expect(previewed.body).toContain("Example");
    expect(previewed.body).toContain("https://example.com/card.png");
    expect(previewed.plainText).toContain("Read http://www.example.com/ before Friday");
    expect(previewed.editedAt).toBeNull();
  });

  it("leaves a message the composer previewed, and links to Ember itself", async () => {
    internet();
    const room = await freshRoom("previewed-link");
    const ada = await connect(room, "Ada");
    const preview = previewAttachment({ url: "http://www.example.com/", title: "Example", description: "An example page.", image: null });
    await post(ada, `<p>http://www.example.com/</p>${preview}`);
    await post(ada, `<p>See ${origin}/rooms/${room}</p>`);
    await settle(ada);
    expect(fetched()).toEqual([]);
  });

  it("previews a message saved again without one, as editing it does", async () => {
    const room = await freshRoom("edited-link");
    const ada = await connect(room, "Ada");
    // Sent while the page couldn't be reached, so it has no preview yet.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const message = await post(ada, "<p>http://www.example.com/</p>");
    await settle(ada);
    vi.restoreAllMocks();

    internet();
    ada.send({ type: "message.update", messageId: message.id, body: message.body });
    expect(previewOf((await updated(ada, message.id)).message)).toBe(true);
  });
});

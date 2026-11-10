import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MembershipProviderContext } from "@/hooks/use-membership-provider";
import { MemberfulSettings } from "./memberful-settings";

describe("MemberfulSettings for a WordPress site", () => {
  const renderCard = (site: string | null, webhooks = false) =>
    render(
      <MembershipProviderContext value={{ kind: "wordpress", name: "Example Club" }}>
        <MemberfulSettings site={site} webhooks={webhooks} checked={site !== null} onCheckedChange={vi.fn()} membersOnly={false} onMembersOnlyChange={vi.fn()} />
      </MembershipProviderContext>,
    );

  it("is named for the site, and turned on without its keys, shows the plugin's steps with WordPress's callback", async () => {
    renderCard(null);
    expect(screen.getByRole("heading", { name: "Example Club" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch"));
    const steps = screen.getByRole("list", { name: "Steps to let WordPress members sign in" });
    expect(steps).toHaveTextContent(`${location.origin}/auth/wordpress/callback`);
    expect(steps).toHaveTextContent("WORDPRESS_CLIENT_SECRET");
    expect(steps).toHaveTextContent(`${location.origin}/webhooks/wordpress`);
  });

  it("once on, says where the site sends people back to, and how to hear its webhooks", () => {
    renderCard("https://members.example.org");
    expect(screen.getByText(/join and sign in with their Example Club account/)).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Steps to sign out members whose membership lapses" })).toHaveTextContent("WORDPRESS_WEBHOOK_SECRET");
    expect(screen.getByText(/the redirect URL its plugin is given/)).toHaveTextContent(`${location.origin}/auth/wordpress/callback`);
  });
});

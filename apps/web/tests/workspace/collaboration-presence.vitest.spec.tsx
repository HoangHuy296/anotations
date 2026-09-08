import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CollaborationPresence } from "@/components/workspace/collaboration-presence";

describe("CollaborationPresence", () => {
  it("renders lightweight accessible viewing/editing detail and no lock control", () => {
    const html = renderToStaticMarkup(<CollaborationPresence members={[
      { userId: "editor-user", assetId: "asset-a", activity: "EDITING" },
      { userId: "viewer-user", assetId: "asset-a", activity: "VIEWING" },
    ]} />);
    expect(html).toContain("Presence: editor-u · Editing this asset; viewer-u · Viewing");
    expect(html).not.toContain("lock");
  });
});

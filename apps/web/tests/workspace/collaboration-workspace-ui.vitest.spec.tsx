import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DiscussionDrawer } from "@/components/workspace/discussion-drawer";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("workspace collaboration UI", () => {
  it("uses an overlay drawer with distinct Discussion and Activity surfaces", () => {
    const html = renderToStaticMarkup(<DiscussionDrawer datasetId="dataset-a" assetId="asset-a" highlightCommentId="comment-a" open onClose={() => undefined} />);
    expect(html).toContain('aria-label="Discussion"');
    expect(html).toContain("fixed inset-0");
    expect(html).toContain(">Discussion<");
    expect(html).toContain(">Activity<");
    expect(html).not.toContain("grid-cols-4");
  });

  it("keeps the existing three-column Properties Panel workspace layout", async () => {
    const source = await readFile(path.resolve(process.cwd(), "src/app/(app)/workspace/[datasetId]/page.tsx"), "utf8");
    expect(source).toContain("lg:grid-cols-[260px_minmax(0,1fr)_280px]");
    expect(source).not.toContain("grid-cols-4");
  });
});

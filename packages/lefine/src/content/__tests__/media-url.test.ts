// mediaUrl: an upload field holds only its media id; the CDN serves the file at
// {cdn}/{workspaceId}/{projectId}/media/{mediaId}/{variant}. mediaUrl builds it from the client's ids.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MEDIA_VARIANTS, mediaUrl } from "../media.js";
import { RichText } from "../react.js";

const ids = { workspaceId: "ws_acme", projectId: "prj_site" };

describe("mediaUrl", () => {
  it("builds the edge URL from the project's ids and CDN; original by default", () => {
    expect(mediaUrl(ids, "med_123")).toBe("https://cdn.lefine.ai/ws_acme/prj_site/media/med_123/original");
    expect(mediaUrl(ids, "med_123", "thumbnail")).toBe("https://cdn.lefine.ai/ws_acme/prj_site/media/med_123/thumbnail");
    expect(mediaUrl({ ...ids, cdnUrl: "http://localhost:8787/cdn/" }, "med_1", "large")).toBe("http://localhost:8787/cdn/ws_acme/prj_site/media/med_1/large");
    expect(MEDIA_VARIANTS).toEqual(["original", "thumbnail", "medium", "large"]);
  });

  it("refuses what is not a media id or a size, so nothing else can be put in the path", () => {
    expect(() => mediaUrl(ids, "../ws_other/prj_x/media/med_1")).toThrow("not a media id and size");
    expect(() => mediaUrl(ids, "app_1")).toThrow("not a media id and size");
    expect(() => mediaUrl(ids, "med_1", "huge" as never)).toThrow("not a media id and size");
  });

  it("is RichText's uploadToSrc", () => {
    const doc = { root: { type: "root", children: [{ type: "upload", relationTo: "media", value: "med_7", fields: { alt: "Team" } }], direction: null, format: "", indent: 0 } };
    // React 19 adds a <link rel="preload"> for the image: read the img itself.
    const html = renderToStaticMarkup(createElement(RichText, { data: doc, disableContainer: true, uploadToSrc: (n) => mediaUrl(ids, n.value, "large") }));
    expect(html).toContain('<img src="https://cdn.lefine.ai/ws_acme/prj_site/media/med_7/large" alt="Team"/>');
  });
});

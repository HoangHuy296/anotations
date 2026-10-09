// Pure rules for drawing a polygon / polyline on the IMAGE canvas. The canvas keeps only the committed vertices in React state (they change on mouse DOWN); the live preview
// (cursor segment, close-candidate highlight, hint) is updated on the Konva nodes directly, so pointer movement never re-renders React or persists anything. A path is persisted
// only by `finish` (one create at the commit boundary); `cancel` and a tool or asset change drop it without any write.

export const POLYGON_CLOSE_THRESHOLD_PX = 12;

export type PathTool = "polygon" | "polyline";
export type PathClickAction = "append" | "finish";

export const isPathTool = (tool: string): tool is PathTool => tool === "polygon" || tool === "polyline";
/** Fewest committed vertices a shape needs: a polygon encloses an area, a polyline is at least one segment. */
export const minimumPathVertices = (tool: PathTool): number => (tool === "polygon" ? 3 : 2);
export const canFinishPath = (tool: string, vertexCount: number): boolean => isPathTool(tool) && vertexCount >= minimumPathVertices(tool);
export const canCancelPath = (vertexCount: number): boolean => vertexCount > 0;

export function isWithinPathCloseThreshold(
  pointer: { x: number; y: number },
  first: { x: number; y: number },
  threshold = POLYGON_CLOSE_THRESHOLD_PX,
): boolean {
  return Math.hypot(pointer.x - first.x, pointer.y - first.y) <= threshold;
}

/** The cursor is in the close zone of the first vertex (screen pixels): only a polygon with at least three vertices can close this way. */
export const isPathClosing = (tool: string, vertexCount: number, nearFirstVertex: boolean): boolean => tool === "polygon" && vertexCount >= minimumPathVertices("polygon") && nearFirstVertex;

/**
 * What a mouse-down does. A second click of a double-click, or (polygon) a click in the close zone of the first vertex, FINISHES the shape at the vertices already committed:
 * the finishing click is never appended as one more vertex. Every other click appends. A shape that is not yet long enough is never finished.
 */
export function classifyPathClick(input: { tool: PathTool; vertexCount: number; doubleClick: boolean; nearFirstVertex: boolean }): PathClickAction {
  if (!canFinishPath(input.tool, input.vertexCount)) return "append";
  if (input.doubleClick) return "finish";
  return isPathClosing(input.tool, input.vertexCount, input.nearFirstVertex) ? "finish" : "append";
}

/** Flat [x0,y0,x1,y1,...] image-space points for the preview line: the committed vertices plus the cursor. */
export function pathPreviewPoints(vertices: ReadonlyArray<readonly [number, number]>, cursor: readonly [number, number] | null, width: number, height: number): number[] {
  const all = cursor ? [...vertices, cursor] : vertices;
  return all.flatMap(([x, y]) => [x * width, y * height]);
}

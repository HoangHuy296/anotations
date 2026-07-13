import "server-only";

import { z } from "zod";

import type {
  GiteaImageCandidate,
  GiteaRepositorySummary,
  GiteaTreeResult,
} from "@/types/gitea";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TREE_ENTRIES = 5_000;
export const MAX_IMPORT_IMAGES = 2_000;

const repositorySchema = z
  .object({
    id: z.number().int().nonnegative(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean().default(false),
    empty: z.boolean().default(false),
    default_branch: z.string().nullish(),
    updated_at: z.string().nullish(),
    owner: z
      .object({
        login: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const treeEntrySchema = z
  .object({
    path: z.string(),
    type: z.enum(["blob", "tree"]),
    sha: z.string(),
    size: z.number().int().nonnegative().nullish(),
  })
  .passthrough();

const treeSchema = z
  .object({
    sha: z.string(),
    truncated: z.boolean().default(false),
    tree: z.array(treeEntrySchema),
  })
  .passthrough();

const imageTypes = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
]);

export class GiteaClientError extends Error {
  constructor(
    public readonly kind:
      | "configuration"
      | "unavailable"
      | "not_found"
      | "rate_limited"
      | "invalid_response",
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GiteaClientError";
  }
}

function getConfiguration() {
  const baseUrlValue = process.env.GITEA_BASE_URL?.trim();
  const token = process.env.GITEA_ACCESS_TOKEN?.trim();

  if (!baseUrlValue || !token) {
    throw new GiteaClientError(
      "configuration",
      "Gitea server configuration is incomplete.",
    );
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    throw new GiteaClientError(
      "configuration",
      "Gitea server configuration is invalid.",
    );
  }

  if (
    !["https:", "http:"].includes(baseUrl.protocol) ||
    (process.env.NODE_ENV === "production" && baseUrl.protocol !== "https:")
  ) {
    throw new GiteaClientError(
      "configuration",
      "Gitea server configuration uses an unsupported protocol.",
    );
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/api/v1/`;
  baseUrl.search = "";
  baseUrl.hash = "";

  return { baseUrl, token };
}

export function getGiteaConnectionDescriptor() {
  const { baseUrl } = getConfiguration();
  const apiSuffix = "/api/v1/";
  const pathname = baseUrl.pathname.endsWith(apiSuffix)
    ? baseUrl.pathname.slice(0, -apiSuffix.length) || "/"
    : baseUrl.pathname;

  return {
    name: "Environment Gitea",
    baseUrl: new URL(pathname, baseUrl).toString().replace(/\/$/, ""),
  };
}

async function readBoundedJson(response: Response) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_JSON_BYTES) {
    throw new GiteaClientError(
      "invalid_response",
      "Gitea returned a response that was too large.",
      response.status,
    );
  }

  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new GiteaClientError(
      "invalid_response",
      "Gitea returned a response that was too large.",
      response.status,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GiteaClientError(
      "invalid_response",
      "Gitea returned malformed JSON.",
      response.status,
    );
  }
}

async function requestJson(path: string, query?: URLSearchParams) {
  const { baseUrl, token } = getConfiguration();
  const url = new URL(path.replace(/^\/+/, ""), baseUrl);
  if (query) {
    url.search = query.toString();
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `token ${token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    if (error instanceof GiteaClientError) {
      throw error;
    }
    throw new GiteaClientError(
      "unavailable",
      "Gitea could not be reached.",
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new GiteaClientError(
        "not_found",
        "The requested Gitea resource was not found.",
        response.status,
      );
    }
    if (response.status === 429) {
      throw new GiteaClientError(
        "rate_limited",
        "Gitea rate limited the request.",
        response.status,
      );
    }
    throw new GiteaClientError(
      "unavailable",
      "Gitea rejected the request.",
      response.status,
    );
  }

  return {
    body: await readBoundedJson(response),
    totalCount: response.headers.get("x-total-count"),
  };
}

async function requestFile(path: string, query?: URLSearchParams) {
  const { baseUrl, token } = getConfiguration();
  const url = new URL(path.replace(/^\/+/, ""), baseUrl);
  if (query) {
    url.search = query.toString();
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/octet-stream",
        Authorization: `token ${token}`,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GiteaClientError(
      "unavailable",
      "Gitea could not be reached.",
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new GiteaClientError(
        "not_found",
        "The requested Gitea file was not found.",
        response.status,
      );
    }
    if (response.status === 429) {
      throw new GiteaClientError(
        "rate_limited",
        "Gitea rate limited the request.",
        response.status,
      );
    }
    throw new GiteaClientError(
      "unavailable",
      "Gitea rejected the file request.",
      response.status,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_BYTES) {
    throw new GiteaClientError(
      "invalid_response",
      "The source image exceeds the 25 MB limit.",
      response.status,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw new GiteaClientError(
      "invalid_response",
      "The source image exceeds the 25 MB limit.",
      response.status,
    );
  }

  return bytes;
}

function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

function normalizeRepository(
  repository: z.infer<typeof repositorySchema>,
): GiteaRepositorySummary {
  return {
    id: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch || "main",
    private: repository.private,
    empty: repository.empty,
    updatedAt: repository.updated_at ?? null,
  };
}

export const giteaClient = {
  async listRepositories(input: { page: number; limit: number }) {
    const query = new URLSearchParams({
      page: String(input.page),
      limit: String(input.limit),
    });
    const response = await requestJson("user/repos", query);
    const parsed = z.array(repositorySchema).safeParse(response.body);

    if (!parsed.success) {
      throw new GiteaClientError(
        "invalid_response",
        "Gitea returned an unexpected repository response.",
      );
    }

    return {
      repositories: parsed.data.map(normalizeRepository),
      totalCount: response.totalCount
        ? Number.parseInt(response.totalCount, 10) || null
        : null,
    };
  },

  async getRepository(owner: string, repo: string) {
    const response = await requestJson(
      `repos/${encodeSegment(owner)}/${encodeSegment(repo)}`,
    );
    const parsed = repositorySchema.safeParse(response.body);

    if (!parsed.success) {
      throw new GiteaClientError(
        "invalid_response",
        "Gitea returned an unexpected repository response.",
      );
    }

    return normalizeRepository(parsed.data);
  },

  async getTree(owner: string, repo: string, ref: string): Promise<GiteaTreeResult> {
    const query = new URLSearchParams({ recursive: "true" });
    const response = await requestJson(
      `repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/trees/${encodeSegment(ref)}`,
      query,
    );
    const parsed = treeSchema.safeParse(response.body);

    if (!parsed.success) {
      throw new GiteaClientError(
        "invalid_response",
        "Gitea returned an unexpected tree response.",
      );
    }

    if (parsed.data.tree.length > MAX_TREE_ENTRIES) {
      throw new GiteaClientError(
        "invalid_response",
        `Repository trees are limited to ${MAX_TREE_ENTRIES} entries.`,
      );
    }

    return {
      sha: parsed.data.sha,
      truncated: parsed.data.truncated,
      entries: parsed.data.tree.map((entry) => ({
        path: entry.path,
        type: entry.type,
        sha: entry.sha,
        size: entry.size ?? null,
      })),
    };
  },

  async getFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ) {
    const encodedPath = filePath.split("/").map(encodeSegment).join("/");
    return requestFile(
      `repos/${encodeSegment(owner)}/${encodeSegment(repo)}/raw/${encodedPath}`,
      new URLSearchParams({ ref }),
    );
  },
};

export function findImageCandidates(
  tree: GiteaTreeResult,
  rootPath: string,
): GiteaImageCandidate[] {
  const prefix = rootPath ? `${rootPath}/` : "";

  return tree.entries.flatMap((entry) => {
    if (
      entry.type !== "blob" ||
      (rootPath && entry.path !== rootPath && !entry.path.startsWith(prefix))
    ) {
      return [];
    }

    const dotIndex = entry.path.lastIndexOf(".");
    const extension =
      dotIndex >= 0 ? entry.path.slice(dotIndex).toLowerCase() : "";
    const mimeType = imageTypes.get(extension);
    if (!mimeType) {
      return [];
    }

    return [
      {
        ...entry,
        filename: entry.path.split("/").at(-1) ?? entry.path,
        mimeType,
      },
    ];
  });
}

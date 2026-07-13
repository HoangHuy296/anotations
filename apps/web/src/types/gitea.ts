export type GiteaRepositorySummary = {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  empty: boolean;
  updatedAt: string | null;
};

export type GiteaTreeEntry = {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size: number | null;
};

export type GiteaTreeResult = {
  sha: string;
  truncated: boolean;
  entries: GiteaTreeEntry[];
};

export type GiteaImageCandidate = GiteaTreeEntry & {
  filename: string;
  mimeType: string;
};

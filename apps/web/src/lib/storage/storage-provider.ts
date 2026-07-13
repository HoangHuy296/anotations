export type StoredObject = {
  key: string;
  size: number;
  contentType: string;
};

export interface StorageProvider {
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | null>;
  put(
    key: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

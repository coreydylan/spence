// Mock R2 bucket for the brigade photo upload scenarios.
//
// Implements just the surface the photo-handler module touches:
//   * `put(key, body, opts)` — store the bytes, capture the metadata.
//   * `get(key)` — return an R2Object-shaped value with `arrayBuffer()`
//                  and `httpMetadata`.
//
// We don't try to emulate R2 features beyond that (no conditional writes,
// no list, no presigned URLs). Tests exercise only put/get.

export interface MockR2PutOptions {
	httpMetadata?: { contentType?: string };
	customMetadata?: Record<string, string>;
}

export interface MockR2Object {
	body: Uint8Array;
	httpMetadata: { contentType: string };
	customMetadata: Record<string, string>;
	written_at_ms: number;
}

interface MockR2Returned {
	httpMetadata: { contentType: string };
	customMetadata: Record<string, string>;
	arrayBuffer: () => Promise<ArrayBuffer>;
}

export class MockR2Bucket {
	private store = new Map<string, MockR2Object>();
	public putCalls: Array<{ key: string; size: number; mime: string; metadata: Record<string, string> }> = [];

	async put(
		key: string,
		body: Uint8Array | ArrayBuffer,
		opts?: MockR2PutOptions,
	): Promise<{ key: string }> {
		const u8 = body instanceof Uint8Array ? body : new Uint8Array(body);
		const entry: MockR2Object = {
			body: u8,
			httpMetadata: { contentType: opts?.httpMetadata?.contentType || "application/octet-stream" },
			customMetadata: { ...(opts?.customMetadata || {}) },
			written_at_ms: Date.now(),
		};
		this.store.set(key, entry);
		this.putCalls.push({
			key,
			size: u8.byteLength,
			mime: entry.httpMetadata.contentType,
			metadata: entry.customMetadata,
		});
		return { key };
	}

	async get(key: string): Promise<MockR2Returned | null> {
		const obj = this.store.get(key);
		if (!obj) return null;
		// Each call creates a fresh ArrayBuffer copy so callers can consume
		// it independently (R2 returns a stream; arrayBuffer materialises it).
		const buf = obj.body.buffer.slice(obj.body.byteOffset, obj.body.byteOffset + obj.body.byteLength);
		return {
			httpMetadata: obj.httpMetadata,
			customMetadata: obj.customMetadata,
			arrayBuffer: async () => buf,
		};
	}

	hasKey(key: string): boolean {
		return this.store.has(key);
	}

	allKeys(): string[] {
		return [...this.store.keys()];
	}

	getRaw(key: string): MockR2Object | null {
		return this.store.get(key) || null;
	}
}
